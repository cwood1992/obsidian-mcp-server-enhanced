#!/usr/bin/env node

// Simple test to check if tools are accessible.
import https from 'https';

const API_KEY = process.env.MCP_AUTH_KEY;
const BASE_URL = process.env.MCP_BASE_URL || 'http://127.0.0.1:3010/mcp';

if (!API_KEY) {
  throw new Error('Set MCP_AUTH_KEY before running this test.');
}

async function testMCP() {
  console.log('Testing MCP server basic functionality...\n');
  
  // Test 1: Initialize
  console.log('1. Testing initialization...');
  const response1 = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream', 
      'Authorization': API_KEY
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    })
  });
  
  const text1 = await response1.text();
  console.log('Initialize response:', text1);
  
  // Try to extract session ID from response headers
  const sessionId = response1.headers.get('mcp-session-id');
  console.log('Session ID from headers:', sessionId);
}

testMCP().catch(console.error);
