# ClickUp MCP for AI Assistants

A Model Context Protocol (MCP) server that enables AI assistants like Claude, Windsurf, and Cursor to interact with your ClickUp tasks.

## Why This MCP Is Great

This MCP excels at providing AI assistants with rich access to your ClickUp tasks:

- **Complete Task Information**: View detailed task data including status, creation date, and assignees
- **Full Comment History**: Access the entire conversation thread for context
- **Inline Images Support**: View images embedded in task descriptions and comments
- **Task Search**: Find relevant tasks using keywords
- **Todo Management**: List all your open tasks

The standout feature is the ability to retrieve individual tickets with their complete comment history and inline images, giving your AI assistant the full context of your work.

## Limitations

- **Todo Management**: The todo management feature is currently limited to 50 tasks since it would otherwise flood the context.
- **No List/Space Support**: This MCP does not currently support browsing ClickUp Lists or Spaces due to performance issues with large instances.
- **Image Limit**: The MCP processes only the 4 most recent images per task to prevent exceeding context limits. You can adjust this number by setting the `MAX_IMAGES` environment variable, though most AI tools have constraints that prevent using more than 4 images.

## Setup for Claude Desktop, Windsurf, or Cursor

1. **Prerequisites**:
   - A ClickUp account with API access (Profile Icon > Settings > Apps > API Token ~ usually starts with pk_)
   - Your ClickUp API key and Team ID (The ~7 digit number in the url when you are in the settings)

2. **Configuration**:
   Add the following to your MCP configuration file:

   ```json
   {
     "mcpServers": {
       "clickup": {
         "command": "npx",
         "args": [
           "-y",
           "@hauptsache.net/clickup-mcp"
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
   - **Claude Desktop**: Add this configuration in Settings > MCPs
   - **Windsurf**: Add to your MCP configuration file
   - **Cursor**: Configure through the MCP settings panel

## Using with Your AI Assistant

Once connected, your AI assistant can:

1. **View Task Details**:
   Ask: "Show me details for task CU-123456"

2. **Search Tasks**:
   Ask: "Find tasks related to login functionality"

3. **Check Your Todo List**:
   Ask: "What tasks are assigned to me?"

The AI will retrieve the information directly from ClickUp, including all text content, comments, and images, providing you with comprehensive assistance on your tasks.

## Configuration

This MCP server can be configured using environment variables:

- `CLICKUP_API_KEY`: (Required) Your ClickUp API key.
- `CLICKUP_TEAM_ID`: (Required) Your ClickUp Team ID (formerly Workspace ID).
- `MAX_IMAGES`: (Optional) The maximum number of images to return for a task in `getTaskById`. Defaults to 4.
- `CLICKUP_PRIMARY_LANGUAGE`: (Optional) A hint for the primary language used in your ClickUp tasks (e.g., "de" for German, "en" for English). This helps the `searchTask` tool provide more tailored guidance in its description for multilingual searches.
- `LANG`: (Optional) If `CLICKUP_PRIMARY_LANGUAGE` is not set, the MCP will check this standard environment variable (e.g., "en_US.UTF-8", "de_DE") as a fallback to infer the primary language.

### Language-Aware Search Guidance

The `searchTask` tool's description will dynamically adjust based on the detected primary language:
- If `CLICKUP_PRIMARY_LANGUAGE` or `LANG` suggests a known primary language (e.g., German), the tool's description will specifically recommend providing search terms in both English and that detected language (e.g., German) for optimal results.
- If no primary language is detected, a more general recommendation for multilingual workspaces will be provided.

This feature aims to improve search effectiveness when the language of user queries (often English) differs from the language of the tasks in ClickUp, without making the MCP itself perform translations. The responsibility for providing bilingual search terms still lies with the agent calling the MCP, but the MCP offers more specific advice if it has a language hint.

## License

ISC
