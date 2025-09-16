# QuickWP Manager

A modern desktop application for managing WordPress development environments with Laravel Herd and WP-CLI integration.

## Features

### 🚀 Smart Auto-Generation

- **Site Title → Everything**: Enter a site title and automatically generate:
  - Folder name (lowercase, hyphenated)
  - Site URL (.test domain)
  - Database name
- **Real-time Preview**: See generated values instantly as you type

### 🖥️ Professional Command Execution

- **Progress Bars**: Visual progress tracking (0-100%)
- **Terminal Output**: Real-time command execution display
- **Step-by-Step Feedback**: See each command as it executes
- **Auto-Launch**: Opens WordPress site automatically after installation

### 🛠️ Advanced Configuration

- **WordPress Version Selection**: Choose from latest or specific versions
- **Database Configuration**: Full control over database settings
- **Debug Settings**: Enable WP_DEBUG with live code preview
- **Theme & Plugin Installation**: Install and activate themes/plugins during setup

### 🎨 Modern UI/UX

- **Tabbed Interface**: Basic and Advanced configuration tabs
- **Real-time Updates**: No save buttons needed - everything updates live
- **Auto-Capitalization Prevention**: Technical fields stay lowercase
- **Responsive Design**: Clean, professional interface

### 📱 Multi-Tab Interface

- **General**: WordPress site creation and management
- **Sites**: View and manage existing WordPress installations
- **PHP**: PHP version management and configuration
- **Node**: Node.js project management and package managers

## Prerequisites

Before using QuickWP Manager, ensure you have the following installed:

- **Laravel Herd**: Local development environment
- **WP-CLI**: WordPress command line interface
- **MySQL/MariaDB**: Database server (via Herd)

## Installation

### Development Setup

1. **Clone the repository**:

   ```bash
   git clone <repository-url>
   cd quickwp-manager
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Run in development mode**:
   ```bash
   npm run tauri dev
   ```

### Building for Production

#### macOS (Intel & Apple Silicon)

```bash
npm run tauri build
```

#### Windows

```bash
npm run tauri build -- --target x86_64-pc-windows-msvc
```

#### Cross-platform builds

The application supports building for:

- **macOS**: Intel (x86_64) and Apple Silicon (aarch64)
- **Windows**: x86_64
- **Linux**: x86_64 (optional)

## Platform Support

### macOS

- **Intel Macs**: macOS 10.13 or later
- **Apple Silicon Macs**: macOS 11.0 or later
- Native performance on both architectures

### Windows

- **Windows 10**: Version 1903 or later
- **Windows 11**: Full support
- x86_64 architecture

## Technology Stack

### Frontend

- **React 18**: Modern React with hooks
- **TypeScript**: Type-safe development
- **Tailwind CSS**: Utility-first CSS framework
- **Headless UI**: Accessible UI components
- **Heroicons**: Beautiful SVG icons

### Backend

- **Tauri**: Rust-based desktop framework
- **Rust**: System-level performance and safety
- **Cross-platform APIs**: File system, process management, shell execution

### Build Tools

- **Vite**: Fast development and building
- **PostCSS**: CSS processing
- **Autoprefixer**: CSS vendor prefixes

## Development

### Project Structure

```
quickwp-manager/
├── src/                    # React frontend
│   ├── components/         # React components
│   │   ├── tabs/          # Tab components
│   │   └── ui/            # UI components
│   ├── App.tsx            # Main application
│   └── App.css            # Styles
├── src-tauri/             # Rust backend
│   ├── src/               # Rust source code
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
├── public/                # Static assets
└── package.json           # Node.js dependencies
```

### Available Scripts

- `npm run dev`: Start Vite development server
- `npm run build`: Build frontend for production
- `npm run tauri dev`: Run Tauri in development mode
- `npm run tauri build`: Build application for production

## Configuration

### Tauri Configuration

The application is configured in `src-tauri/tauri.conf.json`:

- Window settings (size, resizable, etc.)
- Bundle configuration for different platforms
- Security settings and permissions

### Tailwind Configuration

Customized in `tailwind.config.js`:

- Custom color palette
- Extended animations
- Form styling utilities

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test on multiple platforms
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

- **Laravel Herd**: Local development environment
- **WP-CLI**: WordPress command line interface
- **Tauri**: Desktop app framework
- **React**: Frontend framework

## Support

For issues and feature requests, please use the GitHub issue tracker.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
