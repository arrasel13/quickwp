//! Pinned runtime components.
//!
//! Every binary QuickWP runs is verified against a checksum that is a
//! constant in this binary. That pin is the anchor of the supply chain:
//! it is what makes compromising a download host unable to reach an
//! installed user. A hash here was taken from the published asset by
//! `scripts/pin-runtimes.sh`, never from a local build.
//!
//! Regenerate with: scripts/pin-runtimes.sh both
//!
//! PHP comes from static-php.dev's `bulk` variant rather than `common`:
//! common ships pdo_mysql but NOT mysqli, and WordPress requires mysqli
//! specifically -- `wp core install` fails with "missing the MySQL
//! extension" on a common build. bulk also carries intl, imagick, sodium
//! and OPcache, which is the set a real WordPress site expects.
//!
//! NOTE: static-php.dev publishes no PHP 7.4 build. Supporting 7.4 means
//! producing a reproducible build of our own -- tracked, not shipped.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhpPin {
    pub minor: &'static str,
    pub patch: &'static str,
    pub kind: &'static str,
    pub arch: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

pub const PHP_PINS: [PhpPin; 12] = [
    PhpPin {
        minor: "8.0",
        patch: "8.0.30",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.0.30-cli-macos-aarch64.tar.gz",
        sha256: "13c77c837cd50c027e1c614c192b25205123311a30d2335e9a3c8f82d23acb9a",
    },
    PhpPin {
        minor: "8.0",
        patch: "8.0.30",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.0.30-fpm-macos-aarch64.tar.gz",
        sha256: "e91bc2624c4469ceb0d7f7d93d643e1aebadd451556b0b1cc8d5142531b14138",
    },
    PhpPin {
        minor: "8.1",
        patch: "8.1.34",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.1.34-cli-macos-aarch64.tar.gz",
        sha256: "b721271659d6e3448c29c0dc5755ffc4b8a1498c4709e1aba6602cfb584a84e4",
    },
    PhpPin {
        minor: "8.1",
        patch: "8.1.34",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.1.34-fpm-macos-aarch64.tar.gz",
        sha256: "c5faad9eac5ce9753c30a17fb2a2023dcf72e5b367e0ac76b81d006647ea0e52",
    },
    PhpPin {
        minor: "8.2",
        patch: "8.2.32",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.2.32-cli-macos-aarch64.tar.gz",
        sha256: "3c1c359fe943aaaeb1168933b8e4b1597120c106d33bd66395fac403b6ab3ace",
    },
    PhpPin {
        minor: "8.2",
        patch: "8.2.32",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.2.32-fpm-macos-aarch64.tar.gz",
        sha256: "dadddf9b6528f7344ba1f4cdc220bc7e26d2c8402d018f743fe0316d06e4ba77",
    },
    PhpPin {
        minor: "8.3",
        patch: "8.3.32",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.3.32-cli-macos-aarch64.tar.gz",
        sha256: "ac297da5c45c525c660b8d0c73f5aa478ad9005d7c85096dc841220aa9c192e4",
    },
    PhpPin {
        minor: "8.3",
        patch: "8.3.32",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.3.32-fpm-macos-aarch64.tar.gz",
        sha256: "0ceed30f5bd9e54f8a8046c3d28fad549f10220736e15dc16e15855d829fbd81",
    },
    PhpPin {
        minor: "8.4",
        patch: "8.4.23",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.4.23-cli-macos-aarch64.tar.gz",
        sha256: "4a5dca6df0211f7fb21425cf1c867968b2dfb7c079f98cf37770c5728e0bf709",
    },
    PhpPin {
        minor: "8.4",
        patch: "8.4.23",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.4.23-fpm-macos-aarch64.tar.gz",
        sha256: "1a417db44f0eb0b40a9f8cd862f24ecfabdea87f85863f30d218c4876bb688ef",
    },
    PhpPin {
        minor: "8.5",
        patch: "8.5.8",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.5.8-cli-macos-aarch64.tar.gz",
        sha256: "5e5032e8244a2367b1e8a9c70ff6f793dee7433966c9291da85fadf2167cd55f",
    },
    PhpPin {
        minor: "8.5",
        patch: "8.5.8",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/bulk/php-8.5.8-fpm-macos-aarch64.tar.gz",
        sha256: "1d994fbc4e49015a7cd4ad4fcb7c03e7e219f65fdb14e5e33ef1c44d928368e9",
    },
];

/// Minors this build ships, oldest first.
pub const PHP_MINORS: [&str; 6] = ["8.0", "8.1", "8.2", "8.3", "8.4", "8.5"];

/// Past their php.net security-end date. Badged in the UI, never hidden --
/// plenty of real client work runs on a legacy codebase, and a local
/// environment that refuses to run what your client runs is not useful.
pub const PHP_EOL: [&str; 2] = ["8.0", "8.1"];

/// Xdebug is a shared object that must dlopen into the running PHP, and the
/// static 8.0 build does not export the Zend symbols it needs. The toggle is
/// therefore not offered there, rather than offered and then failing at
/// spawn time.
pub const XDEBUG_MIN_MINOR: &str = "8.1";
// ---------------------------------------------------------------- mysql
//
// MySQL publishes official macOS tarballs, so the pin points at the vendor.
// MariaDB does NOT publish a macOS bintar -- supporting it means producing a
// reproducible build of our own, which is tracked rather than claimed. See
// `database::Engine::parse`, which refuses it with that reason.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MysqlPin {
    pub series: &'static str,
    pub version: &'static str,
    pub arch: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

pub const MYSQL_PINS: [MysqlPin; 2] = [
    MysqlPin {
        series: "8.4",
        version: "8.4.9",
        arch: "aarch64",
        url: "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.9-macos15-arm64.tar.gz",
        sha256: "5e1e11782219f81e2246f64f5515af451c36c1167c8158760e17a6854e6e8971",
    },
    MysqlPin {
        series: "8.0",
        version: "8.0.44",
        arch: "aarch64",
        url: "https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-8.0.44-macos15-arm64.tar.gz",
        sha256: "e0a9b7a04051c570706ca4c7b8a8d6749ac984aab9eecfa41c6ca395a75a0c91",
    },
];

/// Series this build ships, newest first.
pub const MYSQL_SERIES: [&str; 2] = ["8.4", "8.0"];

// --------------------------------------------------------------- wp-cli
//
// Architecture-independent: one phar, run by whichever PHP the site uses.
// Bundled rather than required -- asking someone to install WP-CLI before a
// WordPress tool works is asking them to do the tool's job.

pub struct WpCliPin {
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

pub const WPCLI_PIN: WpCliPin = WpCliPin {
    version: "2.12.0",
    url: "https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar",
    sha256: "ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c",
};
