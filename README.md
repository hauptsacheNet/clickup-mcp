# ClickUp MCP for AI Assistants

Transform your AI assistant into a powerful ClickUp integration for both **agentic coding** and **productivity management**. This Model Context Protocol (MCP) server enables Claude, Windsurf, Cursor, and other AI assistants to seamlessly interact with your ClickUp workspace.

## Two Powerful Use Cases

### 🛠️ **For Developers & Agentic Coding**
Originally built to supercharge coding sessions by providing complete task context to AI coding assistants:

- **Instant Requirements**: *"Get task CU-abc123"* → AI gets full requirements, acceptance criteria, comments, and images
- **Complete Context**: Pass entire task histories to Claude Code, Windsurf, or Cursor for informed development
- **Visual Specifications**: Include embedded wireframes, mockups, and screenshots in your coding context
- **Implementation History**: Access all previous discussions and decisions for better code alignment

### 📋 **For Project Management & Productivity**
Extended capabilities for conversational ClickUp management and daily workflow optimization.

## What You Can Do

Turn natural language into powerful ClickUp actions:

**Agentic Coding & Development:**
- *"Look at CU-abc123, can you find the relevant code?"*
- *"Can you build the dashboard like described in https://app.clickup.com/t/12a23b45c?"*
- *"Check task CU-xyz789 and fix the bugs mentioned in the comments"*
- *"Implement the API endpoints described in the integration task"*

**Time Tracking & Productivity:**
- *"Book 2 hours for the client meeting on the XYZ project"*
- *"How much time did I spend on development tasks this week?"*
- *"Log 30 minutes for code review on the authentication feature"*

**Smart Search & Discovery:**
- *"What task did I mention the CSV import in?"*
- *"Find all tasks related to the payment gateway integration"*
- *"Show me tasks where users reported login issues"*

**Daily Workflow Management:**
- *"What do I need to do today?"*
- *"Create a task for fixing the dashboard bug in the frontend list"*
- *"Update the API documentation task to 'in review' status"*
- *"What tasks are blocking the mobile app release?"*

**Rich Context & Collaboration:**
- *"Show me all comments on the user authentication task"*
- *"What's the latest update on the database migration?"*
- *"Add a comment to the design task about the new wireframes"*

## Key Features

### 🔍 **Intelligent Search**
Advanced search across task names, descriptions, comments, and metadata with fuzzy matching and multi-language support.

### 💬 **Complete Context**
Access full comment histories, task descriptions, and embedded images to understand the complete story behind any task.

### ⏱️ **Time Tracking**
Create time entries, view time logs, and analyze where your time is being spent across projects and tasks.

### 🖼️ **Visual Content**
View images embedded in task descriptions and comments, giving your AI assistant visual context for better assistance.

### 📋 **Task Management**
Create, update, and manage tasks with rich metadata including priorities, due dates, assignees, tags, and custom fields.

### 🏗️ **Project Organization**
Navigate spaces, lists, and folders to understand your project structure and get relevant context.

## Setup for Claude Desktop, Windsurf, or Cursor

1. **Prerequisites**:
   - Your `CLICKUP_API_KEY` (Profile Icon > Settings > Apps > API Token ~ usually starts with pk_)
   - and your `CLICKUP_TEAM_ID` (The ~7 digit number in the url when you are in the settings)

2. **Configuration**:
   Add the following to your MCP configuration file:

   ```json
   {
     "mcpServers": {
       "clickup": {
         "command": "npx",
         "args": [
           "-y",
           "@hauptsache.net/clickup-mcp@1"
         ],
         "env": {
           "CLICKUP_API_KEY": "your_api_key",
           "CLICKUP_TEAM_ID": "your_team_id"
         }
       }
     }
   }
   ```

   Replace `your_api_key` and `your_team_id` with your actual ClickUp credentials.

3. **Connect Your AI Assistant**:
   - **Claude Desktop**: Add this configuration in Settings > Developer > Edit Config
   - **Windsurf**: Add to your MCP configuration file
   - **Cursor**: Configure through the MCP settings panel

## MCP Modes & Available Tools

The ClickUp MCP supports three operational modes to balance functionality, security, and performance:

- **🚀 `read-minimal`**: Perfect for AI coding assistants and context gathering
- **📖 `read`**: Full read-only access for project exploration and workflow understanding  
- **✏️ `write`** (Default): Complete functionality for task management and productivity workflows

| Tool | read-minimal | read | write | Description |
|------|:------------:|:----:|:-----:|-------------|
| `getTaskById` | ✅ | ✅ | ✅ | Get complete task details including comments, images, and metadata |
| `searchTasks` | ✅ | ✅ | ✅ | Find tasks by content, keywords, assignees, or project context |
| `listSpaces` | ❌ | ✅ | ✅ | Browse workspace structure and project organization |
| `listLists` | ❌ | ✅ | ✅ | Browse lists and folders within spaces |
| `getListInfo` | ❌ | ✅ | ✅ | Get list details and available statuses for task creation |
| `getTimeEntries` | ❌ | ✅ | ✅ | View time entries and analyze time spent across projects |
| `createTask` | ❌ | ❌ | ✅ | Create new tasks with full markdown support |
| `updateTask` | ❌ | ❌ | ✅ | Update tasks (status, priority, assignees, etc.) with **SAFE APPEND-ONLY** descriptions |
| `updateListInfo` | ❌ | ❌ | ✅ | **SAFE APPEND-ONLY** updates to list descriptions (preserves existing content) |
| `addComment` | ❌ | ❌ | ✅ | Add comments to tasks for collaboration |
| `createTimeEntry` | ❌ | ❌ | ✅ | Log time entries for task tracking |

### Setting the Mode

Add the mode to your MCP configuration:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "npx",
      "args": ["-y", "@hauptsache.net/clickup-mcp@1"],
      "env": {
        "CLICKUP_API_KEY": "your_api_key",
        "CLICKUP_TEAM_ID": "your_team_id",
        "CLICKUP_MCP_MODE": "read"
      }
    }
  }
}
```

## Configuration

This MCP server can be configured using environment variables:

- `CLICKUP_API_KEY`: (Required) Your ClickUp API key.
- `CLICKUP_TEAM_ID`: (Required) Your ClickUp Team ID (formerly Workspace ID).
- `CLICKUP_MCP_MODE`: (Optional) Controls which tools are available. Options: `read-minimal`, `read`, `write` (default).
- `MAX_IMAGES`: (Optional) The maximum number of images to return for a task in `getTaskById`. Defaults to 4.
- `CLICKUP_PRIMARY_LANGUAGE`: (Optional) A hint for the primary language used in your ClickUp tasks (e.g., "de" for German, "en" for English). This helps the `searchTask` tool provide more tailored guidance in its description for multilingual searches.
- `LANG`: (Optional) If `CLICKUP_PRIMARY_LANGUAGE` is not set, the MCP will check this standard environment variable (e.g., "en_US.UTF-8", "de_DE") as a fallback to infer the primary language.

### Language-Aware Search Guidance

The `searchTask` tool's description will dynamically adjust based on the detected primary language:
- If `CLICKUP_PRIMARY_LANGUAGE` or `LANG` suggests a known primary language (e.g., German), the tool's description will specifically recommend providing search terms in both English and that detected language (e.g., German) for optimal results.
- If no primary language is detected, a more general recommendation for multilingual workspaces will be provided.

This feature aims to improve search effectiveness when the language of user queries (often English) differs from the language of the tasks in ClickUp, without making the MCP itself perform translations. The responsibility for providing bilingual search terms still lies with the agent calling the MCP, but the MCP offers more specific advice if it has a language hint.

## Markdown Formatting Support

Task descriptions and list documentation support full markdown formatting:

### Examples

**Task Creation with Markdown:**
```
Create a task called "API Integration" with description:
# API Integration Requirements

## Authentication
- Implement OAuth 2.0 flow
- Add JWT token validation
- **Priority**: High security standards

## Endpoints
1. `/api/users` - User management
2. `/api/data` - Data retrieval
3. `/api/webhook` - Event notifications

## Testing
- [ ] Unit tests for auth flow
- [ ] Integration tests
- [ ] Load testing with 1000+ concurrent users

> **Note**: This replaces the legacy REST implementation

See related task: https://app.clickup.com/t/abc123
```

**Append-Only Updates (Safe):**
When updating task descriptions, content is safely appended:
```markdown
[Existing task description content]

---
**Edit (2024-01-15):** Added new acceptance criteria based on client feedback:
- Must support mobile responsive design
- Performance requirement: < 2s load time
```

This ensures no existing content is ever lost while maintaining a clear audit trail.

## Performance & Limitations

**Optimized for AI Workflows:**
- **Image Processing**: Limited to 4 most recent images per task to prevent running into mcp client limitations (configurable via `MAX_IMAGES`)
- **Search Scope**: Searches within the most recent 1000-3000 tasks to prevent running into rate limits (exact number varies by endpoint)
- **Search Results**: Returns up to 50 most relevant matches to prevent flooding the agent with too many results

**Current Scope:**
- Focused on task-level operations rather than bulk workspace management
- Optimized for conversational AI workflows rather than data migration
- Designed for productivity enhancement, not administrative operations

These limitations ensure reliable performance while covering the most common use cases for both development context and productivity management.

## License

ISC
