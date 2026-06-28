/**
 * DataStore PROJECT.md Agent Memory
 *
 * PROJECT.md is the agent's "memory" for project-specific constraints, known issues, and context.
 * Similar to how Claude Code uses CLAUDE.md, agents read PROJECT.md to understand:
 * - Project constraints (max optical budget, preferred deployment, etc.)
 * - Known issues (blocked conduits, access problems, etc.)
 * - Field notes from technicians
 * - Project history and decisions
 *
 * Agent Behavior:
 * 1. Agent reads PROJECT.md at start of every session
 * 2. When field issue reported (e.g., "Herzl conduit blocked"), agent appends to "Known Issues"
 * 3. When rerouting, agent checks "Known Issues" first to avoid known problems
 * 4. Constraints override system defaults (e.g., client wants 26dB max instead of 28dB)
 */

import type {
  ProjectConstraints,
  ProjectFieldNote,
  ProjectHistory,
  ProjectKnownIssue,
  ProjectMemory,
} from "../types/geocodebase";

// ============================================================================
// PROJECT.md Generation
// ============================================================================

/**
 * Generate PROJECT.md content for a new project
 */
export function generateProjectMd(
  projectName: string,
  location: string,
  addressCount: number,
  constraints?: ProjectConstraints,
): string {
  const date = new Date().toISOString().split("T")[0];

  return `# Project: ${projectName}

## Overview
- **Location**: ${location}
- **Addresses**: ${addressCount}
- **Status**: planning
- **Created**: ${date}

## Constraints
<!-- Project-specific requirements that override defaults -->
${formatConstraints(constraints)}

## Known Issues
<!-- Persistent problems agents should remember -->
- None yet

## Field Notes
<!-- Updates from field technicians -->
- None yet

## Contacts
<!-- Project stakeholders -->
- Project manager: TBD
- Site contact: TBD

## History
<!-- Major decisions and changes -->
- ${date}: Project created

## Decisions
<!-- Agent decisions and user approvals -->
- None yet
`;
}

/**
 * Format constraints section for PROJECT.md
 */
function formatConstraints(constraints?: ProjectConstraints): string {
  if (!constraints) {
    return `- Max optical budget: 28dB (default)
- Preferred deployment: mixed
- Splitter preference: 1:8
- Max drop distance: 100m`;
  }

  const lines: string[] = [];

  lines.push(
    `- Max optical budget: ${constraints.maxOpticalBudget ?? 28}dB${constraints.maxOpticalBudget ? "" : " (default)"}`,
  );
  lines.push(`- Preferred deployment: ${constraints.preferredDeployment ?? "mixed"}`);
  lines.push(`- Splitter preference: ${constraints.splitterPreference ?? "1:8"}`);
  lines.push(`- Max drop distance: ${constraints.maxDropDistance ?? 100}m`);

  if (constraints.maxDistributionDistance) {
    lines.push(`- Max distribution distance: ${constraints.maxDistributionDistance}m`);
  }

  if (constraints.customConstraints) {
    for (const [key, value] of Object.entries(constraints.customConstraints)) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// PROJECT.md Updates
// ============================================================================

type ProjectSection =
  | "constraints"
  | "known_issues"
  | "field_notes"
  | "history"
  | "contacts"
  | "decisions";

/**
 * Update a specific section of PROJECT.md
 * Returns the updated content
 */
export function updateProjectMemory(
  section: ProjectSection,
  entry: string,
  existingContent: string,
): string {
  const date = new Date().toISOString().split("T")[0];
  const timestamp = `[${date}]`;

  // Map section names to markdown headers
  const sectionHeaders: Record<ProjectSection, string> = {
    constraints: "## Constraints",
    known_issues: "## Known Issues",
    field_notes: "## Field Notes",
    history: "## History",
    contacts: "## Contacts",
    decisions: "## Decisions",
  };

  const header = sectionHeaders[section];

  // Find the section in the content
  const headerIndex = existingContent.indexOf(header);
  if (headerIndex === -1) {
    // Section doesn't exist, append at end
    return `${existingContent}\n${header}\n- ${timestamp} ${entry}\n`;
  }

  // Find the next section (or end of file)
  const nextSectionIndex = findNextSection(existingContent, headerIndex + header.length);

  // Get content before and after the section
  const beforeSection = existingContent.substring(0, headerIndex);
  const afterSection = nextSectionIndex === -1 ? "" : existingContent.substring(nextSectionIndex);

  // Get current section content
  const sectionContent =
    nextSectionIndex === -1
      ? existingContent.substring(headerIndex)
      : existingContent.substring(headerIndex, nextSectionIndex);

  // Remove "None yet" if present
  let updatedSection = sectionContent.replace(/- None yet\n?/g, "");

  // Determine where to add the new entry
  if (section === "history") {
    // History entries go at the bottom of the section
    updatedSection = `${updatedSection.trimEnd()}\n- ${timestamp} ${entry}\n`;
  } else {
    // Other entries go at the top (most recent first), after any comments
    const lines = updatedSection.split("\n");
    const headerLineIndex = lines.findIndex((l) => l.startsWith("## "));
    const commentEndIndex = lines.findIndex(
      (l, i) =>
        i > headerLineIndex && !l.startsWith("<!--") && !l.includes("-->") && l.trim() !== "",
    );

    if (commentEndIndex === -1) {
      // No content after header/comments, add entry
      updatedSection = `${updatedSection.trimEnd()}\n- ${timestamp} ${entry}\n`;
    } else {
      // Insert after comments
      lines.splice(commentEndIndex, 0, `- ${timestamp} ${entry}`);
      updatedSection = lines.join("\n");
    }
  }

  return beforeSection + updatedSection + afterSection;
}

/**
 * Find the index of the next ## section header
 */
function findNextSection(content: string, startIndex: number): number {
  const nextHeaderMatch = content.substring(startIndex).match(/\n## /);
  if (!nextHeaderMatch || nextHeaderMatch.index === undefined) {
    return -1;
  }
  return startIndex + nextHeaderMatch.index;
}

// ============================================================================
// PROJECT.md Parsing
// ============================================================================

/**
 * Parse PROJECT.md content into structured data
 */
export function parseProjectMemory(content: string): ProjectMemory {
  const memory: ProjectMemory = {
    projectName: "",
    location: "",
    addressCount: 0,
    status: "planning",
    constraints: {},
    knownIssues: [],
    fieldNotes: [],
    history: [],
    contacts: {},
  };

  // Parse project name from title
  const titleMatch = content.match(/^# Project: (.+)$/m);
  if (titleMatch) {
    memory.projectName = titleMatch[1].trim();
  }

  // Parse overview section
  const locationMatch = content.match(/- \*\*Location\*\*: (.+)$/m);
  if (locationMatch) {
    memory.location = locationMatch[1].trim();
  }

  const addressMatch = content.match(/- \*\*Addresses\*\*: (\d+)/m);
  if (addressMatch) {
    memory.addressCount = parseInt(addressMatch[1], 10);
  }

  const statusMatch = content.match(/- \*\*Status\*\*: (\w+)/m);
  if (statusMatch) {
    memory.status = statusMatch[1].trim() as ProjectMemory["status"];
  }

  // Parse constraints
  memory.constraints = parseProjectConstraints(content);

  // Parse known issues
  memory.knownIssues = parseKnownIssues(content);

  // Parse field notes
  memory.fieldNotes = parseFieldNotes(content);

  // Parse history
  memory.history = parseHistory(content);

  // Parse contacts
  memory.contacts = parseContacts(content);

  // Parse decisions
  memory.decisions = parseDecisions(content);

  return memory;
}

/**
 * Parse constraints section from PROJECT.md content
 */
export function parseProjectConstraints(content: string): ProjectConstraints {
  const constraints: ProjectConstraints = {};

  // Extract constraints section
  const constraintsSection = extractSection(content, "## Constraints");
  if (!constraintsSection) return constraints;

  // Parse each constraint line
  const opticalMatch = constraintsSection.match(/Max optical budget:\s*(\d+(?:\.\d+)?)\s*dB/i);
  if (opticalMatch) {
    constraints.maxOpticalBudget = parseFloat(opticalMatch[1]);
  }

  const deploymentMatch = constraintsSection.match(
    /Preferred deployment:\s*(underground|aerial|mixed)/i,
  );
  if (deploymentMatch) {
    constraints.preferredDeployment = deploymentMatch[1].toLowerCase() as
      | "underground"
      | "aerial"
      | "mixed";
  }

  const splitterMatch = constraintsSection.match(/Splitter preference:\s*(1:\d+)/i);
  if (splitterMatch) {
    constraints.splitterPreference = splitterMatch[1] as "1:4" | "1:8" | "1:16" | "1:32";
  }

  const dropMatch = constraintsSection.match(/Max drop distance:\s*(\d+)\s*m/i);
  if (dropMatch) {
    constraints.maxDropDistance = parseInt(dropMatch[1], 10);
  }

  const distMatch = constraintsSection.match(/Max distribution distance:\s*(\d+)\s*m/i);
  if (distMatch) {
    constraints.maxDistributionDistance = parseInt(distMatch[1], 10);
  }

  return constraints;
}

/**
 * Parse known issues section
 */
function parseKnownIssues(content: string): ProjectKnownIssue[] {
  const issues: ProjectKnownIssue[] = [];
  const section = extractSection(content, "## Known Issues");
  if (!section) return issues;

  // Match entries like: - [2026-01-25] Description
  const entryRegex = /- \[(\d{4}-\d{2}-\d{2})\]\s*(.+?)(?=\n-|\n##|$)/gs;
  let match: RegExpExecArray | null = null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((match = entryRegex.exec(section)) !== null) {
    const [, date, text] = match;
    const issue: ProjectKnownIssue = {
      date,
      description: text.trim(),
    };

    // Try to extract location (often in parentheses or after "at")
    const locationMatch = text.match(/(?:at|near|@)\s+([^()\n]+)/i);
    if (locationMatch) {
      issue.location = locationMatch[1].trim();
    }

    // Try to extract approval
    const approvalMatch = text.match(/\(approved by ([^)]+)\)/i);
    if (approvalMatch) {
      issue.approvedBy = approvalMatch[1].trim();
    }

    issues.push(issue);
  }

  return issues;
}

/**
 * Parse field notes section
 */
function parseFieldNotes(content: string): ProjectFieldNote[] {
  const notes: ProjectFieldNote[] = [];
  const section = extractSection(content, "## Field Notes");
  if (!section) return notes;

  // Match entries like: - [2026-01-25] Note text
  const entryRegex = /- \[(\d{4}-\d{2}-\d{2})\]\s*(.+?)(?=\n-|\n##|$)/gs;
  let match: RegExpExecArray | null = null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((match = entryRegex.exec(section)) !== null) {
    const [, date, text] = match;
    const note: ProjectFieldNote = {
      date,
      note: text.trim(),
    };

    // Try to extract author
    const authorMatch = text.match(/^([^:]+):\s*/);
    if (authorMatch) {
      note.author = authorMatch[1].trim();
      note.note = text.replace(authorMatch[0], "").trim();
    }

    notes.push(note);
  }

  return notes;
}

/**
 * Parse history section
 */
function parseHistory(content: string): ProjectHistory[] {
  const history: ProjectHistory[] = [];
  const section = extractSection(content, "## History");
  if (!section) return history;

  // Match entries like: - [2026-01-25] Event description
  const entryRegex = /- \[?(\d{4}-\d{2}-\d{2})\]?:?\s*(.+?)(?=\n-|\n##|$)/gs;
  let match: RegExpExecArray | null = null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((match = entryRegex.exec(section)) !== null) {
    const [, date, text] = match;
    history.push({
      date,
      event: text.trim(),
    });
  }

  return history;
}

/**
 * Parse decisions section
 */
export function parseDecisions(content: string): string[] {
  const decisions: string[] = [];
  const section = extractSection(content, "## Decisions");
  if (!section) return decisions;

  // Match entries like: - [2026-01-25 14:30] Decision description
  // or: - [2026-01-25] Decision description
  const entryRegex = /- \[(\d{4}-\d{2}-\d{2}[\s\d:]*)\]\s*(.+?)(?=\n-|\n##|$)/gs;
  let match: RegExpExecArray | null = null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((match = entryRegex.exec(section)) !== null) {
    const [, timestamp, text] = match;
    decisions.push(`[${timestamp.trim()}] ${text.trim()}`);
  }

  return decisions;
}

/**
 * Parse contacts section
 */
function parseContacts(content: string): Record<string, string> {
  const contacts: Record<string, string> = {};
  const section = extractSection(content, "## Contacts");
  if (!section) return contacts;

  // Match entries like: - Role: Name/Contact
  const entryRegex = /- ([^:]+):\s*(.+?)(?=\n|$)/g;
  let match: RegExpExecArray | null = null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((match = entryRegex.exec(section)) !== null) {
    const [, role, contact] = match;
    if (contact.toLowerCase() !== "tbd") {
      contacts[role.trim()] = contact.trim();
    }
  }

  return contacts;
}

/**
 * Extract a section from markdown content
 */
function extractSection(content: string, header: string): string | null {
  const headerIndex = content.indexOf(header);
  if (headerIndex === -1) return null;

  const sectionStart = headerIndex + header.length;
  const nextSectionIndex = findNextSection(content, sectionStart);

  return nextSectionIndex === -1
    ? content.substring(sectionStart)
    : content.substring(sectionStart, nextSectionIndex);
}

// ============================================================================
// Helper Functions for Agent Use
// ============================================================================

/**
 * Add a known issue to PROJECT.md
 */
export function addKnownIssue(
  existingContent: string,
  description: string,
  location?: string,
  approvedBy?: string,
): string {
  let entry = description;
  if (location) {
    entry += ` at ${location}`;
  }
  if (approvedBy) {
    entry += ` (approved by ${approvedBy})`;
  }

  return updateProjectMemory("known_issues", entry, existingContent);
}

/**
 * Add a field note to PROJECT.md
 */
export function addFieldNote(existingContent: string, note: string, author?: string): string {
  const entry = author ? `${author}: ${note}` : note;
  return updateProjectMemory("field_notes", entry, existingContent);
}

/**
 * Add a history event to PROJECT.md
 */
export function addHistoryEvent(existingContent: string, event: string): string {
  return updateProjectMemory("history", event, existingContent);
}

/**
 * Update constraints in PROJECT.md
 */
export function updateConstraints(
  existingContent: string,
  newConstraints: Partial<ProjectConstraints>,
): string {
  // Parse existing constraints
  const existing = parseProjectConstraints(existingContent);

  // Merge with new constraints
  const merged: ProjectConstraints = {
    ...existing,
    ...newConstraints,
    customConstraints: {
      ...existing.customConstraints,
      ...newConstraints.customConstraints,
    },
  };

  // Find and replace constraints section
  const constraintsHeader = "## Constraints";
  const headerIndex = existingContent.indexOf(constraintsHeader);
  if (headerIndex === -1) {
    return existingContent;
  }

  const nextSectionIndex = findNextSection(existingContent, headerIndex + constraintsHeader.length);

  const beforeSection = existingContent.substring(0, headerIndex);
  const afterSection = nextSectionIndex === -1 ? "" : existingContent.substring(nextSectionIndex);

  const newConstraintsSection = `${constraintsHeader}
<!-- Project-specific requirements that override defaults -->
${formatConstraints(merged)}

`;

  return beforeSection + newConstraintsSection + afterSection;
}

/**
 * Check if a location is in the known issues list
 */
export function hasKnownIssueAt(content: string, location: string): boolean {
  const issues = parseKnownIssues(content);
  const normalizedLocation = location.toLowerCase();

  return issues.some(
    (issue) =>
      issue.location?.toLowerCase().includes(normalizedLocation) ||
      issue.description.toLowerCase().includes(normalizedLocation),
  );
}

/**
 * Get all known issues for a specific location
 */
export function getKnownIssuesAt(content: string, location: string): ProjectKnownIssue[] {
  const issues = parseKnownIssues(content);
  const normalizedLocation = location.toLowerCase();

  return issues.filter(
    (issue) =>
      issue.location?.toLowerCase().includes(normalizedLocation) ||
      issue.description.toLowerCase().includes(normalizedLocation),
  );
}
