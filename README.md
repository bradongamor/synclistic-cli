# Synclistic CLI

The CLI is the reference execution surface for Synclistic. It runs the shared engine directly for sync, export, and import workflows.

## Support Status

Supported sync objects:

- `pages`
- `blogs`
- `articles`
- `collections`
- `products`
- `media`
- `menus`
- `themes`

The CLI rejects unsupported placeholder objects such as `metafields`, `metaobjects`, and `selling plans` with a non-zero exit code.

## Smoke Harness

Run the opt-in smoke harness with:

```bash
npm run smoke
```

It skips cleanly unless all of these environment variables are set:

- `SYNCLISTIC_SMOKE_SOURCE_NAME`
- `SYNCLISTIC_SMOKE_SOURCE_URL`
- `SYNCLISTIC_SMOKE_SOURCE_TOKEN`
- `SYNCLISTIC_SMOKE_DESTINATION_NAME`
- `SYNCLISTIC_SMOKE_DESTINATION_URL`
- `SYNCLISTIC_SMOKE_DESTINATION_TOKEN`

Optional:

- `SYNCLISTIC_SMOKE_OUTPUT_PATH`

When configured, the smoke run exercises:

- each supported sync object type individually: `pages`, `blogs`, `articles`, `collections`, `products`, `media`, `menus`, and `themes`
- export/import round-trip for `pages`

Synclistic CLI is a command-line interface application for managing Shopify store details. It allows users to add new stores, list existing stores, remove stores, and sync objects between stores.

## Installation

Prerequisite: Node.js 20 or newer.

### From npm

During the beta period, install the npm package with:

```bash
npm install -g synclistic@beta
```

After Synclistic is promoted to the `latest` dist-tag, install it with:

```bash
npm install -g synclistic
```

### From a local release artifact

To validate or install a local release artifact, pack the CLI and install the generated tarball:

```bash
PACKAGE_TGZ="$(npm pack --silent)"
npm install -g "./$PACKAGE_TGZ"
```

If you are running an older Node.js version, Synclistic exits early with a runtime version error before loading the CLI.

## Usage

After installation, you can use the Synclistic CLI commands as described in the Commands section below.

## Commands

Synclistic CLI supports the following commands:

### Display help information

```
synclistic -h
synclistic --help
```

This command displays help information, including a list of all available commands and their descriptions.

### Display version information

```
synclistic -v
synclistic --version
```

This command displays the current version of Synclistic CLI.

### List required Shopify Admin API scopes

```
synclistic scopes
```

This command prints the Shopify Admin API scopes required for each supported sync object type.

### Add a new Shopify store

```
synclistic add store
```

This command prompts for the store name, store URL, and API key. API key input is masked in the terminal. Store URLs may be entered as either a bare host like `shop.myshopify.com` or a full URL like `https://shop.myshopify.com/admin`; Synclistic normalizes new saves to the bare host form.
Synclistic stores the API key in your system credential store and keeps only store metadata in `stores.json`.

### List all stored Shopify stores

```
synclistic list stores
```

This command displays a table of all stored Shopify stores.

### Remove a Shopify store

```
synclistic remove store
```

This command allows you to select and remove a store from the stored list.

### Sync objects between two Shopify stores

```
synclistic sync [objects...] [options]
```

This command syncs specified objects between two Shopify stores. The source and destination stores can be specified optionally. If not provided, the CLI will prompt you to select the stores.

Supported sync objects are: `pages`, `blogs`, `articles`, `collections`, `products`, `media`, `menus`, and `themes`.

Options:
- `-f, --from <source>`: Specify the source store name (optional)
- `-t, --to <destination>`: Specify the destination store name (optional)
- `-c, --clean-destination`: Remove objects from destination that don't exist in source (optional, default: false)
- `--create-only`: Only create new objects that exist in source but not in destination (optional)
- `--update-only`: Only update existing objects that exist in both stores (optional)
- `--sync-mode <mode>`: Sync mode: create-and-update | create | update (optional, default: create-and-update)
- `--source-products-ids <ids>`: Source product IDs (numeric or gid, comma-separated) for product ID sync (optional)
- `--destination-products-ids <ids>`: Destination product IDs (numeric or gid, comma-separated; empty entries allowed) for product ID sync (optional)
- `--theme-sync-mode <mode>`: Theme sync mode: `dependencies` | `full` (optional, default: `dependencies`)
- `--destination-theme-id <id>`: Destination theme ID override for theme sync (optional, defaults to the published theme)
- `--missing-template-policy <policy>`: Missing template policy: `clear` | `keep` | `error` (optional, default: `clear`)
- `-e, --export`: Export destination store data before syncing (optional)
- `-o, --output <path>`: Output directory for export files, used with --export (optional, defaults to ~/synclistic-exports/)
- `--on-export-failure <behavior>`: Export failure behavior: continue | fail (optional, default: fail, only used with --export)
- `-v, --verbose`: Enable verbose logging with detailed operation information (optional)

Note: `--create-only` and `--update-only` cannot be used together.

Examples:
``` 
synclistic sync pages products articles -f store1 -t store2
synclistic sync pages products
synclistic sync pages products -c
synclistic sync pages products --clean-destination
synclistic sync pages products --create-only
synclistic sync pages products --update-only
synclistic sync themes -f store1 -t store2 --theme-sync-mode full
synclistic sync pages products -f store1 -t store2 --missing-template-policy error
synclistic sync products -f store1 -t store2 --source-products-ids 1234567890 --destination-products-ids 9876543210 --sync-mode create-and-update
synclistic sync products -f store1 -t store2 --source-products-ids gid://shopify/Product/1234567890 --sync-mode create-and-update
synclistic sync products -f store1 -t store2 --source-products-ids 111,222,333 --destination-products-ids 444,,666 --sync-mode create-and-update
synclistic sync pages products -v
synclistic sync pages products --export
synclistic sync pages products --export -o backups/
```

In examples without store names, you will be prompted to select the source and destination stores. Clean-destination defaults to `false`, and sync mode defaults to `create-and-update`.

When using the `--export` flag, the destination store's data will be exported to JSON files before the sync begins. This provides a safety backup in case you need to restore the data.

**Destructive sync guardrail:** `--clean-destination` is blocked unless internal test mode is enabled and the destination store is explicitly marked as a test store.

**Product ID sync (non-interactive):** Provide `--source-products-ids` (required) and optionally `--destination-products-ids`. When these are provided with `--from`, `--to`, `--sync-mode`, `--clean-destination`, and `--on-export-failure`, the command runs without prompts. Numeric IDs are normalized to Shopify gid format. Destination lists must match the source list length; empty destination entries (for example, `444,,666`) are treated as “create new.”

**Important: Shopify media filename behavior**

When syncing product media, Shopify’s Admin API only accepts `originalSource` URLs and always creates new product media assets. Shopify appends UUIDs to those media filenames and does not allow renaming or attaching existing Files by ID. This is a Shopify API limitation and is out of Synclistic’s control. Synclistic avoids creating extra Files during product sync to prevent unused originals, but the product media entries themselves will still have UUID-suffixed filenames.

### Deduplicate objects in a Shopify store

```
synclistic dedupe <objects...> [options]
```

This command currently supports deduplication for `products`, `pages`, `articles`, `blogs`, and `menus`.

Options:
- `-s, --store <store>`: Specify the store name (optional)

Example:
```
synclistic dedupe products -s mystore
synclistic dedupe products
```

In the second example, you will be prompted to select a store if not specified.

### Export store data to JSON files

```
synclistic export [objects...] [options]
```

This command exports objects from a Shopify store to JSON files. Exports can be used as backups before destructive operations or for importing into other stores.

Supported export objects include: `articles`, `blogs`, `collections`, `media`, `menus`, `pages`, and `products`.

Options:
- `-s, --store <store>`: Specify the store to export from (optional)
- `-o, --output <path>`: Output directory for export files (optional, defaults to ~/synclistic-exports/)
- `-a, --all`: Export all supported object types (optional)
- `-v, --verbose`: Enable verbose logging (optional)

Examples:
```
synclistic export pages products -s mystore
synclistic export pages products -s mystore -o backups/
synclistic export --all -s mystore
synclistic export
```

In the last example, you will be prompted to select a store and object types.

Export files are saved as JSON with the naming convention: `{store_name}_{object_type}_{timestamp}.json`

Each export file contains metadata including:
- Export version
- Store URL and name
- Object type
- Creation timestamp
- Item count
- Full data array

**Media Export:** When exporting media, actual files are downloaded to a `media/{timestamp}/` subdirectory alongside the JSON manifest. This ensures media can be fully restored even if the original files are deleted from Shopify. The JSON file contains local file paths that the import command uses to upload files.

**Path Resolution:** All paths (for export, import, and sync --export) are resolved relative to your home directory (`~`), not the current working directory. This means:
- `synclistic-exports` → `~/synclistic-exports`
- `./backups` → `~/backups`
- `~/my-exports` → `~/my-exports`
- `/absolute/path` → `/absolute/path` (absolute paths are used as-is)

### Import data from export files

```
synclistic import <path> [options]
```

This command imports objects from export files into a Shopify store. You can import a single file or all files in a directory.

Options:
- `-s, --store <store>`: Target store for import (optional)
- `--dry-run`: Preview what would be imported without making changes (optional)
- `--create-only`: Only create new objects, skip updates (optional)
- `--update-only`: Only update existing objects, skip creates (optional)
- `-v, --verbose`: Enable verbose logging (optional)

Examples:
```
synclistic import synclistic-exports/mystore_products_2024-01-09T120000.json -s targetstore
synclistic import synclistic-exports/ -s targetstore
synclistic import ~/backups/ --dry-run
synclistic import /absolute/path/to/backup.json --create-only
```

The import command:
- Matches objects by `handle` (consistent with sync behavior)
- Shows a preview of files to import and prompts for confirmation
- Supports dry-run mode to preview changes without making them
- Can import single files or entire directories of export files

## Local Validation

This repository mirrors the publishable CLI package. It is not intended to behave like a full source checkout.

To validate a local artifact checkout:

```bash
npm pack --dry-run
TMP_INSTALL_DIR="$(mktemp -d)"
PACKAGE_TGZ="$(npm pack --silent)"
npm install "$PWD/$PACKAGE_TGZ" --prefix "$TMP_INSTALL_DIR"
"$TMP_INSTALL_DIR/node_modules/.bin/synclistic" --help
```

## Uninstallation

To uninstall the CLI, use:

```
npm uninstall -g synclistic
```

## File Storage

Store metadata is saved in the following locations:

- On Unix-like systems (Linux, macOS):
  - If `XDG_CONFIG_HOME` is set: `$XDG_CONFIG_HOME/synclistic/stores.json`
  - Otherwise: `~/.config/synclistic/stores.json`
- On Windows:
  - `%APPDATA%\synclistic\stores.json` (typically `C:\Users\<username>\AppData\Roaming\synclistic\stores.json`)

The configuration directory is created automatically with appropriate permissions (700). The stores file itself is created with restricted permissions (600), but it now contains metadata only and no API keys.

Store credentials are saved in the native OS credential store:

- On macOS: Keychain
- On Windows: Credential Manager
- On Linux: Secret Service/libsecret

When Synclistic starts with an older plaintext `stores.json`, it migrates those API keys into the system credential store and rewrites the file without `api_key`.
If secure credential storage is unavailable, Synclistic fails closed and does not write secrets to disk. On Linux, this means you need an available Secret Service-compatible keyring.

## Dependencies

- commander
- chalk
- form-data
- inquirer
- validator
- cli-table3

For more details, see the `package.json` file.

## Logging and Performance

Synclistic CLI uses an asynchronous logging system for optimal performance during sync operations. The logging system includes:

- Non-blocking asynchronous log processing
- Configurable log levels (DEBUG, VERBOSE, INFO, WARN, ERROR)
- Message buffering and batching for improved performance
- Automatic log flushing at configurable intervals
- Color-coded output for better readability

### Log Levels

- DEBUG: Detailed debugging information
- VERBOSE: Additional information about operations (enabled with -v flag)
- INFO: General operational information (default)
- WARN: Warning messages
- ERROR: Error messages (processed immediately)

### Performance Features

- Asynchronous message queuing
- Configurable buffer size (default: 1000 messages)
- Automatic flush interval (default: 100ms)
- Lazy evaluation of verbose messages
- Immediate processing of error messages

To enable verbose logging, use the `-v` or `--verbose` flag with the sync command:

```bash
synclistic sync products -v
```

## License

This package is licensed under the [MIT License](LICENSE).
