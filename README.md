# QuickWP

A modern desktop application for managing WordPress development environments, built with Tauri and React.

## Features

- **Site Management**: Create, manage, and monitor WordPress sites
- **PHP Version Management**: Install and switch between different PHP versions
- **Node.js Management**: Install and manage Node.js versions
- **Laravel Herd Integration**: Seamless integration with Laravel Herd
- **WP-CLI Integration**: Built-in WordPress CLI functionality
- **Real-time Updates**: Live monitoring without manual refresh
- **Cross-platform**: Works on macOS, Windows, and Linux

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
- [Laravel Herd](https://herd.laravel.com/) (for WordPress site management)
- [WP-CLI](https://wp-cli.org/) (for WordPress command-line operations)

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
