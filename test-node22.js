#!/usr/bin/env node

console.log('Testing with Node:', process.version);

// Test basic imports
try {
  console.log('Testing @modelcontextprotocol/sdk import...');
  const mcp = require('@modelcontextprotocol/sdk/server/mcp.js');
  console.log('✓ MCP SDK loaded successfully');
} catch (error) {
  console.error('✗ Failed to load MCP SDK:', error.message);
}

try {
  console.log('Testing stdio transport import...');
  const stdio = require('@modelcontextprotocol/sdk/server/stdio.js');
  console.log('✓ Stdio transport loaded successfully');
} catch (error) {
  console.error('✗ Failed to load stdio transport:', error.message);
}

// Test loading the main module
try {
  console.log('Testing main index.js...');
  require('./dist/index.js');
  console.log('✓ Main module loaded successfully');
} catch (error) {
  console.error('✗ Failed to load main module:', error.message);
  console.error('Stack:', error.stack);
}