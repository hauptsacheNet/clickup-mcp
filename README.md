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
- **No Lists/Spaces Support**: This MCP does not currently support browsing ClickUp Lists or Spaces due to performance issues with large instances.

## Setup for Claude Desktop, Windsurf, or Cursor

Setting up this MCP is simple and works the same way across all platforms (Windows, macOS, Linux):

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

## License

ISC
