#!/bin/bash

# QuickWP Manager Build Script
# Builds the application for multiple platforms

set -e

echo "🚀 QuickWP Manager Build Script"
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "src-tauri" ]; then
    print_error "Please run this script from the quickwp-manager directory"
    exit 1
fi

# Check if Node.js and npm are installed
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js first."
    exit 1
fi

if ! command -v npm &> /dev/null; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

# Check if Rust and Cargo are installed
if ! command -v cargo &> /dev/null; then
    print_error "Rust/Cargo is not installed. Please install Rust first."
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    print_status "Installing Node.js dependencies..."
    npm install
    print_success "Dependencies installed"
fi

# Build options
BUILD_TARGET=""
BUILD_DEBUG=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --target)
            BUILD_TARGET="$2"
            shift 2
            ;;
        --debug)
            BUILD_DEBUG=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --target TARGET    Build for specific target (e.g., x86_64-pc-windows-msvc)"
            echo "  --debug           Build in debug mode"
            echo "  --help, -h        Show this help message"
            echo ""
            echo "Supported targets:"
            echo "  x86_64-apple-darwin      macOS Intel"
            echo "  aarch64-apple-darwin     macOS Apple Silicon"
            echo "  x86_64-pc-windows-msvc   Windows 64-bit"
            echo "  x86_64-unknown-linux-gnu Linux 64-bit"
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Determine build command
BUILD_CMD="npm run tauri build"

if [ "$BUILD_DEBUG" = true ]; then
    BUILD_CMD="npm run tauri build -- --debug"
    print_warning "Building in debug mode"
fi

if [ -n "$BUILD_TARGET" ]; then
    BUILD_CMD="$BUILD_CMD -- --target $BUILD_TARGET"
    print_status "Building for target: $BUILD_TARGET"
fi

# Start build process
print_status "Starting build process..."
print_status "Command: $BUILD_CMD"

# Run the build
eval $BUILD_CMD

if [ $? -eq 0 ]; then
    print_success "Build completed successfully!"
    print_status "Build artifacts can be found in src-tauri/target/release/bundle/"
    
    # List the generated files
    if [ -d "src-tauri/target/release/bundle" ]; then
        print_status "Generated files:"
        find src-tauri/target/release/bundle -name "*.dmg" -o -name "*.app" -o -name "*.exe" -o -name "*.msi" -o -name "*.deb" -o -name "*.AppImage" | while read file; do
            echo "  📦 $(basename "$file")"
        done
    fi
else
    print_error "Build failed!"
    exit 1
fi

print_success "🎉 QuickWP Manager build complete!"
