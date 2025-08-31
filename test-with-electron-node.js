#!/usr/bin/env node

console.log('Node version:', process.version);
console.log('Node path:', process.execPath);
console.log('Platform:', process.platform);
console.log('Architecture:', process.arch);
console.log('Working directory:', process.cwd());
console.log('Script location:', __filename);

// Test if we can run the MCP
try {
  console.log('\nAttempting to load MCP...');
  require('./dist/index.js');
  console.log('MCP loaded successfully!');
} catch (error) {
  console.error('Error loading MCP:', error.message);
  console.error('Stack:', error.stack);
}