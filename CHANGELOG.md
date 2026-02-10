# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added `getFolderInfo` tool to get folder details (name, lists, parent space, statuses) by folder ID
- Added comparison table in README showing differences between this MCP and the official ClickUp MCP

### Fixed
- Fixed image MIME type detection by inspecting binary magic bytes instead of trusting HTTP headers or fallback values

## [1.6.0] - 2025-11-25

### Added
- **Full markdown support for comments** - `addComment` now converts markdown to ClickUp's rich text format
- Comments now preserve formatting when reading back from ClickUp, including nested formatting

## [1.5.1] - 2025-10-02

### Changed
- The space resource now has a `ClickUp Space` suffix in the title.
- Add additional hints to all tools to potentially improve client handling.

### Added
- Added Icon to the manifest.json file.

## [1.5.0] - 2025-10-01

### Breaking Changes
- Replaced `writeDocument` tool with two focused tools for better clarity:
  - `updateDocumentPage`: Updates existing pages (requires doc_id and page_id)
  - `createDocumentOrPage`: Creates new documents or pages (uses space_id/list_id/doc_id)
- This change makes parameter requirements clearer and eliminates the confusion between creating and updating operations

### Fixed
- Fixed "my-todos" prompt failing with "Failed to get prompt" error in Claude Desktop by adding `prompts_generated: true` to manifest.json to declare runtime-generated prompts
- Fixed critical bug in document page updates: now uses correct ClickUp API v3 endpoint (`/workspaces/{teamId}/docs/{docId}/pages/{pageId}`) instead of incorrect endpoint that was causing 404 errors
- Fixed empty response handling in `updateDocumentPage` - now gracefully handles ClickUp API responses that don't return JSON body

### Removed
- Removed `searchDocuments` tool as it only searched document names/spaces, not content, which confused LLMs that are trained on fulltext searches. Documents can still be discovered via `searchSpaces` (which includes documents in space tree) or by direct URL.

### Changed
- Removed time entries from `searchTasks` results to improve reliability and prevent rate limit issues. Time entries are still available via `getTaskById` for individual tasks.
- Updated `readDocument` to reference new tool names (`updateDocumentPage` and `createDocumentOrPage`) in its suggestions

## [1.4.3] - 2025-09-26

### Fixed
- Add required `title` field to MCP space resources to comply with newer MCP specification

## [1.4.2] - 2025-09-23

### Added
- Task dependency and relationship management in `updateTask` tool (thanks @itinance)

### Fixed
- Strip inline base64 data URIs from `getTaskById` responses and surface them as proper image blocks instead of embedding them in text content

## [1.4.1] - 2025-08-31

### Fixed
- Fixed tag management in `updateTask` - tags are now properly added/removed using dedicated API endpoints (thanks @itinance)
- Fixed Claude Desktop dxt support. It had the word `cli` in the argument list which triggered the cli debug mode of this library.

## [1.4.0] - 2025-08-18

### Added
- MCP Resources support for dynamic ClickUp space discovery
  - Spaces now appear in Claude Desktop's resource dropdown for easy selection
  - Dynamic resource templates provide real-time space listing without server restart
  - Complete space tree structure with lists, folders, documents, and metadata
  - Resource URIs using `clickup://space/{spaceId}` format for consistent identification

## [1.3.2] - 2025-08-05

### Fixed
- Fix `writeDocument` API response parsing when creating pages in existing documents
- Add fallback handling for both nested (`data.page`) and flat response formats

## [1.3.1] - 2025-07-22

### Added
- Add `readOnlyHint` annotations to all MCP tools to improve user experience
- Add a prompt for "my-todos" in English and German, as a shortcut.

## [1.3.0] - 2025-07-11

### Added
- Document management tools for ClickUp Docs
  - `readDocument` - Read documents with page structure and content
  - `searchDocuments` - Search documents by name and space with fuzzy matching
  - `writeDocument` - Create and update documents and pages with smart parent detection
- Added Server instructions with all ClickUp Spaces to help the LLM make better decisions.

### Fixed
- Null attachment handling in task metadata
- URL generation for lists and spaces

### Improved
- Enhanced search relevance weighting for multi-term queries
- Optimized search scoring with multiple term matches

## [1.2.0] - 2025-07-02

### Added
- Claude DXT manifest.json file for enhanced integration
- Intelligent image handling for ClickUp tasks
- Parent task ID support in task creation and update operations
- Space tags fetching and display in list tools
- Status filtering enhancements in search tools
- Space search functionality replacing generic listing tools

### Changed
- Task description and status update guidelines clarified
- Server version now loaded dynamically from package.json
- Improved caching for promises and enhanced time entries handling
- Split task tools write functionality into separate module for better modularity
- Simplified task-tools descriptions for assignees and update tracking

### Fixed
- Enhanced promise caching to prevent race conditions

## [1.1.1] - 2025-06-17

### Added
- ClickUp URL generation and markdown link formatting utilities
- Enhanced time tools with team-wide filtering and hierarchical output
- New formatting utilities for better data presentation

### Changed
- Simplified private field handling and removed redundant URL guidance
- Improved tool integration for enhanced navigation

## [1.1.0] - 2025-06-16

### Added
- Safe append-only updates for task and list descriptions with markdown support
- MCP mode support and tool segmentation for configurable functionality
- Enhanced time and list tools with getListInfo functionality
- Assignee-based filtering and updates across task tools
- Task comments and status updates support
- Extended valid task ID length to 6-9 characters

### Changed
- Updated README with experimental notice and enhanced feature details
- Enhanced tool descriptions with best practices and important usage notes
- Enriched README with expanded usage examples and optimized AI workflows
- Consolidated task creation/update logic, removed create-tools
- Modularized task search with filters, caching, and fuzzy matching
- Simplified server setup and improved code modularity

### Fixed
- Improved task creation and update functionalities for assignees

## [1.0.5] - 2025-06-03

### Added
- Enhanced task metadata with priority, dates, time estimates, tags, watchers, URL, archived status, and custom fields

## [1.0.4] - 2025-05-26

### Added
- Chronological status history and comment events to task content

### Fixed
- Handle non-string text items in ClickUp text parser by stringifying unknown types

## [1.0.3] - 2025-05-22

### Added
- Fuzzy search with Fuse.js and language-aware search guidance
- Space details to task metadata and .env configuration support
- Enhanced task search to support direct task ID lookups alongside text search

## [1.0.2] - 2025-05-09

### Added
- Image limit functionality with MAX_IMAGES env var and newest-first sorting
- Parent/child task metadata and improved documentation

## [1.0.1] - 2025-05-08

### Fixed
- Executable configuration for npx usage

## [1.0.0] - 2025-05-08

### Added
- Initial release of ClickUp MCP server
- Task search and retrieval functionality
- Markdown and text processing capabilities
- Image processing with attachment support
- MCP server setup and configuration
- Basic README with setup instructions

### Changed
- Consolidated markdown and text processing into unified clickup-text module
- Improved markdown image processing with dedicated loader function

### Fixed
- Initial setup and configuration for npm publishing
