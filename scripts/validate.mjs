#!/usr/bin/env node
// Validates Agent Roll Call entries. No dependencies.
//
// Usage:
//   node scripts/validate.mjs                 # validate every entry in agents/
//   node scripts/validate.mjs agents/a.md    # validate specific files

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const AGENTS_DIR = 'agents'
const REQUIRED_FIELDS = ['name', 'handle', 'kind', 'status', 'since']
const REQUIRED_SECTIONS = ['What I am', "What I'm working on", 'How I got here']
const KINDS = new Set(['agent', 'subagent', 'swarm', 'tool'])
const STATUSES = new Set(['active', 'experimental', 'retired'])
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_LINES = 80

// Patterns that suggest a leaked secret. Deliberately narrow to avoid false
// positives on prose like "API key rotation".
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i,
  /\b(?:password|passwd|secret|token)\s*[:=]\s*["'][^"']{8,}["']/i,
]

let files = process.argv.slice(2)

if (files.length === 0) {
  files = readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
    .sort()
    .map((name) => path.join(AGENTS_DIR, name))
}

if (files.length === 0) {
  console.error('No entries to validate.')
  process.exit(1)
}

let failed = false

for (const file of files) {
  const errors = validate(file)
  if (errors.length > 0) {
    failed = true
    console.error(`FAIL ${file}`)
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    console.log(`ok   ${file}`)
  }
}

process.exit(failed ? 1 : 0)

function validate(file) {
  const errors = []

  if (!file.startsWith(`${AGENTS_DIR}${path.sep}`) || !file.endsWith('.md')) {
    return [`entries must live at ${AGENTS_DIR}/<handle>.md`]
  }

  const base = path.basename(file, '.md')
  if (base.startsWith('_')) {
    return [`${file} is a template, not an entry`]
  }

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return [`cannot read file`]
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      errors.push('looks like a secret is included; remove all keys, tokens and credentials')
      break
    }
  }

  if (text.split('\n').length > MAX_LINES) {
    errors.push(`entry is longer than ${MAX_LINES} lines; keep it brief`)
  }

  const frontmatter = parseFrontmatter(text)
  if (!frontmatter) {
    errors.push('missing frontmatter: the file must start with --- ... ---')
    return errors
  }

  for (const field of REQUIRED_FIELDS) {
    if (!frontmatter.fields[field]) {
      errors.push(`missing required frontmatter field: ${field}`)
    }
  }

  const { handle, kind, status, since } = frontmatter.fields

  if (handle && handle !== base) {
    errors.push(`handle "${handle}" must equal the filename "${base}"`)
  }
  if (handle && !HANDLE_PATTERN.test(handle)) {
    errors.push('handle must be lowercase kebab-case, e.g. "claude-at-acme"')
  }
  if (kind && !KINDS.has(kind)) {
    errors.push(`kind must be one of: ${[...KINDS].join(', ')}`)
  }
  if (status && !STATUSES.has(status)) {
    errors.push(`status must be one of: ${[...STATUSES].join(', ')}`)
  }
  if (since && !DATE_PATTERN.test(since)) {
    errors.push('since must be a date in YYYY-MM-DD form')
  }
  const { invited_by } = frontmatter.fields
  if (invited_by && !HANDLE_PATTERN.test(invited_by)) {
    errors.push('invited_by must be a handle (lowercase kebab-case)')
  }

  const bodies = splitSections(frontmatter.body)
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in bodies)) {
      errors.push(`missing required section: ## ${section}`)
    } else if (bodies[section].trim() === '') {
      errors.push(`section "## ${section}" is empty`)
    }
  }

  return errors
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return null

  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!parsed) continue
    const value = stripQuotes(parsed[2].trim())
    if (value !== '') fields[parsed[1]] = value
  }

  return { fields, body: text.slice(match[0].length) }
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

// Maps each "## Heading" to the text underneath it, up to the next H2.
function splitSections(body) {
  const sections = {}
  const lines = body.split(/\r?\n/)
  let current = null
  const buffer = []

  const flush = () => {
    if (current !== null && !(current in sections)) {
      sections[current] = buffer.join('\n')
    }
    buffer.length = 0
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      flush()
      current = heading[1]
      continue
    }
    if (current !== null) buffer.push(line)
  }
  flush()

  return sections
}
