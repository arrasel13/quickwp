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
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.0.30-cli-macos-aarch64.tar.gz",
        sha256: "af2e06f1c0e872712177dda3478434890ed9bfc278f5435ed7d82f989b28a080",
    },
    PhpPin {
        minor: "8.0",
        patch: "8.0.30",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.0.30-fpm-macos-aarch64.tar.gz",
        sha256: "7c772214eb13c64764e3a175a978056d9e003f176394c5a15cf724dbc063a754",
    },
    PhpPin {
        minor: "8.1",
        patch: "8.1.34",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.1.34-cli-macos-aarch64.tar.gz",
        sha256: "4feae4b89a6a2b1d0f1c9cc6bbb37e7a7f299a392a6f8f207946fc60c6ed631a",
    },
    PhpPin {
        minor: "8.1",
        patch: "8.1.34",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.1.34-fpm-macos-aarch64.tar.gz",
        sha256: "b74703381bcf31c647acd7600b80bd6cb97c997a578d5feccc2cd57524a7cff7",
    },
    PhpPin {
        minor: "8.2",
        patch: "8.2.32",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.2.32-cli-macos-aarch64.tar.gz",
        sha256: "074e50b2b039a5f2c0830dd30494d714a10128f0d8eaf0e5e0c0dbe70c33d7f7",
    },
    PhpPin {
        minor: "8.2",
        patch: "8.2.32",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.2.32-fpm-macos-aarch64.tar.gz",
        sha256: "16cdb8ab5c8003765f779eecf51d4bd06a527a30a28bc1fab31f4096b6b6c8b0",
    },
    PhpPin {
        minor: "8.3",
        patch: "8.3.32",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.3.32-cli-macos-aarch64.tar.gz",
        sha256: "1cc8148750bd1722031daba1618825a8b7d0a3830bb92c50d8dd844a1dcfb306",
    },
    PhpPin {
        minor: "8.3",
        patch: "8.3.32",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.3.32-fpm-macos-aarch64.tar.gz",
        sha256: "3164721ae2dd6615048180c44f63bede09ba42060c73d2027af8150d2ebbd0f6",
    },
    PhpPin {
        minor: "8.4",
        patch: "8.4.23",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.4.23-cli-macos-aarch64.tar.gz",
        sha256: "bba286e442796dbd420d778a016e2817b31d5036d11b3ba316d19a60de912cdc",
    },
    PhpPin {
        minor: "8.4",
        patch: "8.4.23",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.4.23-fpm-macos-aarch64.tar.gz",
        sha256: "038ea93f7ec17d125ddb09c68d099e72d68c5ee4c235048fe5fe2f720de6484f",
    },
    PhpPin {
        minor: "8.5",
        patch: "8.5.8",
        kind: "cli",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.5.8-cli-macos-aarch64.tar.gz",
        sha256: "cba9bd8b38b51ef2c7cebf02af689e4481bbd07f65edc0b63d3a43b04e0c9db7",
    },
    PhpPin {
        minor: "8.5",
        patch: "8.5.8",
        kind: "fpm",
        arch: "aarch64",
        url: "https://dl.static-php.dev/static-php-cli/common/php-8.5.8-fpm-macos-aarch64.tar.gz",
        sha256: "612489ba5cc217d7f76fa585b0a5f01fe68176dbe5b2c2e015f1e02a2424ddaa",
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
