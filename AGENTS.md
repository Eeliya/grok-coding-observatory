# Observatory Setup for AI Coding Agents

This file provides instructions for AI coding agents on how to set up and use the Coding Observatory in development projects.

## Quick Setup (Recommended)

When starting work on a project, set up the observatory to run automatically alongside the dev server:

### 1. Install Dependencies

```bash
npm install --save-dev concurrently
```

### 2. Update package.json

Modify your `package.json` to run the observatory alongside your dev server:

```json
{
  "scripts": {
    "dev": "concurrently -n \"dev,obs\" -c \"blue,magenta\" \"npm run dev:server\" \"npx grok-coding-observatory .\"",
    "dev:server": "vite",
    "dev:obs": "npx grok-coding-observatory ."
  }
}
```

**Adjust for your project:**
- Replace `"vite"` with your actual dev command (e.g., `"next dev"`, `"npm run start"`, etc.)
- If your dev script is already named something else, preserve it and wrap both commands

### 3. Start Development

```bash
npm run dev
```

This will start both your dev server and the observatory. View changes at **http://localhost:4477**

## Alternative: Manual Start

If you prefer to run the observatory separately:

```bash
# Terminal 1: Start your dev server
npm run dev

# Terminal 2: Start the observatory
npx grok-coding-observatory .
```

## Reporting Your Status

To let the human see what you're working on, report your status:

```bash
# When starting a task
grok-observatory working "Implementing user authentication"

# When running tests or other commands
grok-observatory working "Running tests"

# When finished
grok-observatory done "Authentication complete, all tests passing"
```

### For Multi-Step Tasks

Publish your plan and track progress:

```bash
# Set your plan at the start
grok-observatory plan set "Read existing code" "Implement feature" "Write tests" "Update docs"

# Mark steps as you progress
grok-observatory step start 1
# ... do work ...
grok-observatory step done 1

grok-observatory step start 2
# ... do work ...
grok-observatory step done 2
```

### Check Your Inbox

The human can send you messages through the observatory. Check your inbox regularly:

```bash
# Check for messages (run before/after each step, and before your final reply)
grok-observatory inbox

# Reply to messages
grok-observatory reply "I've completed the authentication feature as requested."
```

## Full Protocol Documentation

For complete details on the status protocol, plan management, and chat features, see:
[docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md)

## Configuration

The observatory uses sensible defaults but can be configured via environment variables:

```bash
# Run on a different port (if 4477 is in use)
PORT=4478 npx grok-coding-observatory .

# Watch a different directory
npx grok-coding-observatory /path/to/repo
```

## Project-Specific Setup

**For Vite projects:**
```json
{
  "scripts": {
    "dev": "concurrently \"vite\" \"npx grok-coding-observatory .\""
  }
}
```

**For Next.js projects:**
```json
{
  "scripts": {
    "dev": "concurrently \"next dev\" \"npx grok-coding-observatory .\""
  }
}
```

**For Express/Node servers:**
```json
{
  "scripts": {
    "dev": "concurrently \"nodemon server.js\" \"npx grok-coding-observatory .\""
  }
}
```

**For Create React App:**
```json
{
  "scripts": {
    "start": "concurrently \"react-scripts start\" \"npx grok-coding-observatory .\""
  }
}
```

## Requirements

- Node.js 22.6 or newer
- Git repository (the folder must be inside a git work tree)
- A modern browser for the human to view changes

## Troubleshooting

**Port already in use:**
```bash
# Use a different port
PORT=4478 npx grok-coding-observatory .
```

**Observatory not showing changes:**
- Ensure you're saving files (not just editing in memory)
- Check that the folder is a git repository: `git rev-parse --git-dir`
- Verify the observatory is running: `curl http://localhost:4477/api/repos`

**Package not found:**
The observatory is published on GitHub. Use:
```bash
npx github:Eeliya/grok-coding-observatory
```

## Best Practices

1. **Set up once:** Add the concurrently setup to package.json at the start of work
2. **Report status:** Always report when starting tasks, running commands, and finishing
3. **Check inbox:** Check between steps and before your final reply
4. **Keep it running:** Leave the observatory running throughout your work session
5. **Inform the human:** Let them know the observatory is available at http://localhost:4477

## Example Workflow

```bash
# 1. Set up the project (first time only)
npm install --save-dev concurrently
# Update package.json dev script

# 2. Start development
npm run dev
# Observatory is now running at http://localhost:4477

# 3. Report your status
grok-observatory working "Refactoring authentication module"

# 4. Do your work (edit files, git commits, etc.)
# The human can see all changes live in their browser

# 5. Check for messages periodically
grok-observatory inbox

# 6. Report completion
grok-observatory done "Refactoring complete, tests passing, 5 files changed"
```

## Privacy & Security

- The observatory runs **locally only** (binds to 127.0.0.1)
- It **never sends code anywhere** (only loads Monaco editor from CDN)
- It **never modifies your work tree** (only reads via git and filesystem)
- Status files are stored in `.git/observatory/` (never committed)

## Getting Help

- Full documentation: [README.md](README.md)
- Agent protocol: [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md)
- HTTP API: [docs/API.md](docs/API.md)
- Issues: https://github.com/Eeliya/grok-coding-observatory/issues
