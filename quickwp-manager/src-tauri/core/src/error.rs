use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("{0}")]
    Bare(#[from] std::io::Error),

    #[error("download failed for {url}: {source}")]
    Download {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// The anchor of the whole supply chain. A mismatch is never recoverable by
    /// retrying against the same host, so it is its own variant rather than a
    /// generic failure: the message has to say what was expected and what came.
    #[error("checksum mismatch for {component}\n  expected {expected}\n  received {actual}\nThe download was discarded. Nothing was written.")]
    ChecksumMismatch {
        component: String,
        expected: String,
        actual: String,
    },

    #[error("port {port} is already in use by {holder}")]
    PortInUse { port: u16, holder: String },

    #[error("{component} is not installed")]
    NotInstalled { component: String },

    #[error("unknown PHP version {0}")]
    UnknownPhpVersion(String),

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn other(msg: impl Into<String>) -> Self {
        Error::Other(msg.into())
    }
}

/// Errors cross the Tauri IPC boundary as strings, so the Display impl above is
/// the user-facing message. Keep them actionable.
impl From<Error> for String {
    fn from(e: Error) -> String {
        e.to_string()
    }
}
