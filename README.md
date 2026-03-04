# Woniru Engine Installer (WE)

This repository contains the **public NPX installer** for **Woniru Engine (WE)**.

The installer is intentionally small and public. It **does not** contain the engine source code.  
Instead, it guides the user through GitHub authorization and then **downloads the private WE repository** (only if the user has access), installs dependencies, and launches a local configuration wizard.

---

## Quick Start

Run the installer using NPX:

```bash
npx @woniru/we-installer
```

## What the Installer Does

1. The installer performs the following steps:
1. Opens a browser to authorize with GitHub using the Device Flow.
1. Verifies that the user has collaborator access to the private Woniru Engine repository.
1. Downloads the engine source code from the repository.
1. Runs npm install in the project directory.
1. Launches a local configuration wizard.

## The configuration wizard guides the user through:

### Step 1 — Redis Setup

- Connect to an existing Redis instance, or

- Automatically create a new Redis instance using Docker.

### Step 2 — Database Configuration

- Database host

- Database user

- Database password

- Database name

- Applies the WE schema to the database.

### Step 3 — Admin Access

- Creates the initial admin user.

- Displays commands required to start the server.

## Default Admin Credentials

After installation completes, the default admin account is:

**Username:** 
``` 
admin@we.com 
```

**Password:**
``` 
weAdmin 
```

These credentials can be changed after logging into the system.

## Commands After Installation

The installer provides two commands:

**Start the server:** 
```
npm run dev --redisAdminKey=<your-admin-key>
```

**Recalculate user permissions:**
```
 npm run recalculate:user-permissions
```

The second command is only required if permissions need to be recalculated after changes.

## Access Control

This installer is public, but the **Woniru Engine repository is private**.

If you are a collaborator on the repository, the installer will download the engine successfully.

If you are not authorized, the installer will stop with an access error.

## Requirements

Before running the installer ensure the following are installed:

**Node.js** version 18 or higher

**npm** version 9 or higher

**Docker Desktop** for running private redis instance

Network access is required for:

- GitHub
- npm registry
- your configured database server