# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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