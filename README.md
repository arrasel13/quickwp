# QuickWP

A modern desktop application for managing WordPress development environments, built with Tauri and React.

## Features

- **Owns its stack**: PHP and friends are downloaded on demand and pinned by
  SHA-256. No Herd, no Docker, no VM.
- **Site management**: create sites, or link a folder you already have --
  a linked folder is never copied, moved or deleted, not even when you delete
  the site.
- **Per-site PHP**: one php-fpm pool per version, switchable per site without
  regenerating any config.
- **Per-site stop/start**: a stopped site answers its own 503 rather than
  falling through to a neighbour.
- **php.ini editor**: a whitelist of the directives local development actually
  needs, edited per version, validated before it can break a pool.

macOS on Apple Silicon today. The platform-specific parts are isolated;
Windows and Linux are not built.

## Tech Stack

- **Frontend**: React + TypeScript + Tailwind CSS
- **Backend**: Tauri (Rust)
- **Build Tool**: Vite
- **UI Components**: Heroicons
- **Styling**: Tailwind CSS with custom components

## Prerequisites

Before running this project, make sure you have:

- [Node.js](https://nodejs.org/) (version 18 or higher)
- [Rust](https://rustup.rs/) (latest stable version)

That is the whole list. **QuickWP owns its own stack** -- it downloads PHP and
the rest on demand, verifies each against a checksum compiled into the app, and
supervises them itself. There is no Laravel Herd, no Docker, no VM, and nothing
to install through Homebrew.

An internet connection is needed the first time you use a component. A PHP
version is about 30MB and is fetched once.

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/arrasel13/quickwp.git
   cd quickwp
   ```

2. Navigate to the application directory:

   ```bash
   cd quickwp-manager
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the development server:

   ```bash
   npm run tauri dev
   ```

### Verifying the stack yourself

Two runnable proofs live in the core crate:

```bash
cd quickwp-manager/src-tauri/core
cargo test                       # 14 tests, including a refused checksum
cargo run --example spike        # download -> verify -> pool -> execute PHP
cargo run --example serve        # create sites -> serve them over HTTP
```

`scripts/pin-runtimes.sh` regenerates the checksums in
`core/src/runtime/pins.rs`. Hashes are always taken from the published asset,
never from a local build.

## Building for Production

To build the application for production:

```bash
npm run tauri build
```

This will create platform-specific installers in the `src-tauri/target/release/bundle/` directory.

## Development

### Project Structure

```
quickwp-manager/
├── src/                    # React frontend source
│   ├── components/         # React components
│   │   ├── tabs/          # Tab components (Sites, PHP, Node, etc.)
│   │   └── ui/            # Reusable UI components
│   ├── hooks/             # Custom React hooks
│   ├── types/             # TypeScript type definitions
│   └── utils/             # Utility functions
├── src-tauri/             # Tauri backend source
│   ├── src/               # Rust source code
│   ├── icons/             # Application icons
│   └── tauri.conf.json    # Tauri configuration
└── public/                # Static assets
```

### Available Scripts

- `npm run dev` - Start Vite development server
- `npm run build` - Build the React app
- `npm run tauri dev` - Start Tauri development mode
- `npm run tauri build` - Build the Tauri application
- `npm run lint` - Run ESLint
- `npm run preview` - Preview the built app

## Features Overview

### Sites Tab

- View and manage WordPress sites
- Site status monitoring
- Quick actions for common tasks
- Integration with Laravel Herd

### PHP Tab

- Install and manage PHP versions
- Configure PHP settings (memory limit, upload size)
- Laravel Installer management
- PHP update notifications

### Node Tab

- Install and manage Node.js versions
- Version switching capabilities
- Support for major Node.js releases

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Tauri](https://tauri.app/) - For the amazing desktop app framework
- [Laravel Herd](https://herd.laravel.com/) - For WordPress development environment
- [WP-CLI](https://wp-cli.org/) - For WordPress command-line interface
