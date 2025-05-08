# ClickUp MCP (Model Context Protocol)

A minimal implementation of a Model Context Protocol (MCP) server for ClickUp integration, designed to allow Large Language Models (LLMs) to interact with ClickUp tasks and data.

## Overview

This MCP provides a lightweight interface for LLMs to:
- Retrieve detailed task information by ID
- Search for tasks using keywords
- List open tasks assigned to the current user

The implementation includes image handling for task descriptions, allowing LLMs to process both text content and visual information from ClickUp tasks.

## Prerequisites

- Node.js (v16 or higher)
- A ClickUp account with API access
- ClickUp API key and Team ID

## Installation

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Build the TypeScript code:

```bash
npm run build
```

## Configuration

Set the following environment variables:

- `CLICKUP_API_KEY`: Your ClickUp API key
- `CLICKUP_TEAM_ID`: Your ClickUp team ID

You can set these variables in your environment or create a `.env` file at the root of the project.

## Usage

### As an MCP Server

To use this as an MCP server with an LLM:

```bash
npm start
```

This will start the server using the standard input/output for communication, following the Model Context Protocol.

### CLI Usage

For testing or manual usage, you can use the CLI interface:

```bash
# List all available tools
npm run cli

# Get a task by ID
npm run cli getTaskById id=abc1234

# Search for tasks
npm run cli searchTask terms="feature|bug|enhancement"

# List open tasks for the current user
npm run cli listTodo
```

## Available Tools

### getTaskById

Retrieves a complete ClickUp task with its description, comments, and embedded images.

Parameters:
- `id`: The 7-9 character ClickUp task ID (without "#" or "CU-" prefix)

### searchTask

Searches for tasks by name with support for multiple search terms (using OR logic).

Parameters:
- `terms`: Search terms separated by '|' (e.g., 'term1|term2|term3')

### listTodo

Lists all open tasks assigned to the current user.

Parameters: None

## Development

For development with hot reloading:

```bash
npm run dev
```

Format code with Prettier:

```bash
npm run prettier
```

## How It Works

This MCP implementation:

1. Connects to the ClickUp API using your API key
2. Provides tools for LLMs to query and process ClickUp data
3. Handles image processing in Markdown descriptions
4. Returns structured data in a format optimized for LLM consumption

## License

ISC
