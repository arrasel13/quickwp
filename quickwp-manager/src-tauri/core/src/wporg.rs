//! Searching the WordPress.org directory, as wp-admin's "Add plugin" screen
//! does.
//!
//! Asked from here rather than from the page: the directory's API sends no
//! CORS headers, so a webview cannot read it, and the answers want tidying
//! anyway -- the directory returns names and authors as HTML.

use crate::{Error, Result};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DirectoryItem {
    pub slug: String,
    pub name: String,
    pub version: String,
    /// Plain text: the directory sends the author as a link.
    pub author: String,
    pub description: String,
    /// The plugin's icon or the theme's screenshot, where there is one.
    pub image: Option<String>,
    /// Out of 100, as the directory scores them.
    pub rating: u32,
    pub num_ratings: u32,
    /// Plugins only: how many sites run it. Zero when it is not reported.
    pub active_installs: u64,
    pub homepage: String,
}

/// One page of the directory: a search, or the popular list when the query is
/// empty. `kind` is "plugin" or "theme".
pub async fn search(kind: &str, query: &str, page: u32) -> Result<Vec<DirectoryItem>> {
    let query = query.trim();
    let page = page.max(1);
    let url = match kind {
        "plugin" => {
            let mut u = format!(
                "https://api.wordpress.org/plugins/info/1.2/?action=query_plugins\
                 &request%5Bper_page%5D=24&request%5Bpage%5D={page}\
                 &request%5Bfields%5D%5Bshort_description%5D=1&request%5Bfields%5D%5Bicons%5D=1\
                 &request%5Bfields%5D%5Bsections%5D=0&request%5Bfields%5D%5Bdescription%5D=0"
            );
            if query.is_empty() {
                u.push_str("&request%5Bbrowse%5D=popular");
            } else {
                u.push_str(&format!("&request%5Bsearch%5D={}", urlencode(query)));
            }
            u
        }
        "theme" => {
            let mut u = format!(
                "https://api.wordpress.org/themes/info/1.2/?action=query_themes\
                 &request%5Bper_page%5D=24&request%5Bpage%5D={page}\
                 &request%5Bfields%5D%5Bdescription%5D=1&request%5Bfields%5D%5Bscreenshot_url%5D=1"
            );
            if query.is_empty() {
                u.push_str("&request%5Bbrowse%5D=popular");
            } else {
                u.push_str(&format!("&request%5Bsearch%5D={}", urlencode(query)));
            }
            u
        }
        other => return Err(Error::other(format!("unknown kind {other}"))),
    };

    let body = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Nexora")
        .build()
        .map_err(|e| Error::other(format!("no HTTP client: {e}")))?
        .get(&url)
        .send()
        .await
        .map_err(|e| Error::other(format!("WordPress.org could not be reached: {e}")))?
        .text()
        .await
        .map_err(|e| Error::other(format!("WordPress.org sent nothing readable: {e}")))?;

    parse(kind, &body)
}

fn parse(kind: &str, body: &str) -> Result<Vec<DirectoryItem>> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| Error::other(format!("WordPress.org sent no usable answer: {e}")))?;
    // The directory reports its own errors in the body, with a 200.
    if let Some(message) = root.get("error").and_then(|e| e.as_str()) {
        return Err(Error::other(message.to_string()));
    }
    let list = root
        .get(if kind == "plugin" { "plugins" } else { "themes" })
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(list.iter().map(|row| item(kind, row)).collect())
}

fn item(kind: &str, row: &serde_json::Value) -> DirectoryItem {
    let text = |key: &str| row.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let number = |key: &str| row.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    let slug = text("slug");

    // Plugins send the author as an anchor; themes send an object.
    let author = match row.get("author") {
        Some(serde_json::Value::Object(o)) => o
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Some(serde_json::Value::String(s)) => plain(s),
        _ => String::new(),
    };

    let image = if kind == "plugin" {
        row.get("icons")
            .and_then(|i| i.get("2x").or_else(|| i.get("1x")).or_else(|| i.get("svg")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    } else {
        Some(text("screenshot_url")).filter(|s| !s.is_empty()).map(|s| {
            // Themes give a protocol-relative URL.
            if let Some(rest) = s.strip_prefix("//") { format!("https://{rest}") } else { s }
        })
    };

    let description = plain(&if kind == "plugin" {
        text("short_description")
    } else {
        text("description")
    });

    DirectoryItem {
        name: plain(&text("name")),
        version: text("version"),
        author,
        description,
        image,
        rating: row.get("rating").and_then(|v| v.as_f64()).unwrap_or(0.0).round() as u32,
        num_ratings: number("num_ratings") as u32,
        active_installs: number("active_installs"),
        homepage: if kind == "plugin" {
            format!("https://wordpress.org/plugins/{slug}/")
        } else {
            format!("https://wordpress.org/themes/{slug}/")
        },
        slug,
    }
}

/// Tags out, the handful of entities the directory uses decoded.
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&#039;", "'")
        .replace("&#8217;", "\u{2019}")
        .replace("&#8211;", "\u{2013}")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&hellip;", "\u{2026}")
        .trim()
        .to_string()
}

/// Percent-encoding for one query value. Only what a search box can hold.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugin_row_comes_back_as_plain_text() {
        let body = r#"{"info":{"page":1},"plugins":[{
            "name":"Yoast SEO &amp; more","slug":"wordpress-seo","version":"22.0",
            "author":"<a href=\"https://yoast.com\">Team Yoast</a>",
            "short_description":"The #1 <strong>SEO</strong> plugin&hellip;",
            "icons":{"1x":"https://ps.w.org/wordpress-seo/assets/icon-128x128.png","2x":"https://ps.w.org/wordpress-seo/assets/icon-256x256.png"},
            "rating":92.4,"num_ratings":27000,"active_installs":13000000}]}"#;
        let items = parse("plugin", body).unwrap();
        assert_eq!(items.len(), 1);
        let p = &items[0];
        assert_eq!(p.name, "Yoast SEO & more");
        assert_eq!(p.author, "Team Yoast");
        assert_eq!(p.description, "The #1 SEO plugin\u{2026}");
        assert_eq!(p.image.as_deref(), Some("https://ps.w.org/wordpress-seo/assets/icon-256x256.png"));
        assert_eq!(p.rating, 92);
        assert_eq!(p.active_installs, 13_000_000);
        assert_eq!(p.homepage, "https://wordpress.org/plugins/wordpress-seo/");
    }

    #[test]
    fn a_theme_row_keeps_its_screenshot_and_author() {
        let body = r#"{"themes":[{"name":"Twenty Twenty-Five","slug":"twentytwentyfive","version":"1.1",
            "author":{"display_name":"the WordPress team"},
            "screenshot_url":"//ts.w.org/wp-content/themes/twentytwentyfive/screenshot.png",
            "description":"A blogging theme.","rating":98,"num_ratings":12}]}"#;
        let items = parse("theme", body).unwrap();
        let t = &items[0];
        assert_eq!(t.author, "the WordPress team");
        assert_eq!(t.image.as_deref(), Some("https://ts.w.org/wp-content/themes/twentytwentyfive/screenshot.png"));
        assert_eq!(t.homepage, "https://wordpress.org/themes/twentytwentyfive/");
    }

    #[test]
    fn the_directory_s_own_error_is_an_error() {
        assert!(parse("plugin", r#"{"error":"Query field missing."}"#).is_err());
        // Nothing found is no rows, not a failure.
        assert!(parse("plugin", r#"{"plugins":[]}"#).unwrap().is_empty());
    }

    /// Against the real directory:
    /// `cargo test -p nexora-core live_directory -- --ignored --nocapture`.
    #[test]
    #[ignore = "asks wordpress.org"]
    fn live_directory_answers_a_search_and_the_popular_list() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let found = rt.block_on(search("plugin", "seo", 1)).expect("plugin search");
        println!("plugins for \"seo\": {}", found.len());
        for p in found.iter().take(3) {
            println!("  {} {} by {} — {} installs, icon {:?}", p.name, p.version, p.author, p.active_installs, p.image.is_some());
        }
        assert!(found.len() > 5, "the directory has plenty of SEO plugins");
        assert!(found.iter().all(|p| !p.slug.is_empty() && !p.name.contains('<')));

        let themes = rt.block_on(search("theme", "blog", 1)).expect("theme search");
        println!("themes for \"blog\": {}", themes.len());
        for t in themes.iter().take(3) {
            println!("  {} {} by {} — screenshot {:?}", t.name, t.version, t.author, t.image.is_some());
        }
        assert!(themes.len() > 5);
        assert!(themes.iter().all(|t| t.image.is_some()));

        let popular = rt.block_on(search("plugin", "", 1)).expect("popular");
        println!("popular: {}", popular.iter().take(3).map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "));
        assert!(popular.len() > 5);
    }

    #[test]
    fn a_search_term_is_encoded_for_the_query_string() {
        assert_eq!(urlencode("seo & more"), "seo+%26+more");
        assert_eq!(urlencode("wp-rocket"), "wp-rocket");
    }
}
