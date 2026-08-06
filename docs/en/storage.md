# File Storage Guide

> **File storage is disabled by default.** Provision an S3-compatible storage backend (local MinIO, AWS S3, Cloudflare R2, etc.), then register it under Settings → Storage to enable this feature.

AZITO provides per-project file storage backed by [MinIO](https://min.io/), an S3-compatible object storage server. You can upload files via the sidebar or drag-and-drop, and copy shareable URLs for use in chat or documentation.

## MinIO Setup

AZITO includes a `docker-compose.yml` at the project root that defines a MinIO service.

### Start MinIO

```bash
docker compose up -d
```

This starts MinIO with the following defaults:

| Setting | Value |
|---|---|
| API endpoint | `http://localhost:9000` |
| Console (web UI) | `http://localhost:9001` |
| Root user | `minioadmin` |
| Root password | `minioadmin` |
| Data volume | `minio-data` (Docker managed) |

The MinIO console at `http://localhost:9001` lets you browse buckets and objects directly if needed.

### Verify MinIO is running

```bash
docker compose ps
```

You should see the `azito-minio` container in a running state.

## Configuration

Once MinIO is running, configure AZITO to connect to it:

1. Open any project Workspace.
2. Switch to **Settings** in the activity bar (gear icon).
3. Find the **Storage** section and enter:

| Field | Value | Description |
|---|---|---|
| Endpoint | `http://localhost:9000` | MinIO API URL |
| Access Key | `minioadmin` | MinIO root user |
| Secret Key | `minioadmin` | MinIO root password |
| Bucket | `azito` | Bucket name (created automatically) |
| Region | `us-east-1` | Default region |
| Max File Size | `52428800` | Maximum upload size in bytes (default: 50 MB) |

AZITO will automatically create the bucket if it does not exist on first upload.

## Uploading Files

### From the sidebar

1. Open the Workspace and switch to the **Storage** sidebar mode (box icon in the activity bar).
2. Click the **Upload** button.
3. Select one or more files from the file picker.

### Drag and drop

Drag files from your desktop directly onto the Storage sidebar panel. A blue highlight indicates the drop zone is active.

![Screenshot: Storage panel with drag-and-drop highlight active](placeholder)

### Upload progress

While a file is uploading, a spinner appears in the panel. A toast notification confirms success or reports errors.

## Managing Files

The Storage panel lists all uploaded files for the current project, showing:

- File name
- File size
- Upload time (relative, e.g., "2h ago")

### Copying URLs

Click the **copy** icon next to any file to copy its URL to the clipboard. The URL is a presigned S3 URL that provides temporary access to the file.

### Thumbnails

Image files (JPEG, PNG, GIF, WebP, SVG) display a small thumbnail preview in the file list.

### Deleting files

Click the **delete** icon next to a file to remove it from storage. This action is permanent.

## Production Considerations

For production use, consider the following changes:

- **Change the default credentials** -- Update `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in `docker-compose.yml` and in the AZITO storage settings.
- **Persistent storage** -- The Docker volume `minio-data` persists data across container restarts. For backups, consider mounting a host directory instead.
- **HTTPS** -- If MinIO is accessed over the network, configure TLS or place it behind a reverse proxy.
