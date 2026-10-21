import path from "node:path"
import type { Config, PermissionReply, PermissionRequest, PermissionRule, SavedPermissionView } from "@openorch/shared"
import type { AgentDef } from "./agents/index.js"
import { createSqlitePermissionStore, type SavedPermissionStore, type SqliteDb } from "./storage.js"
import { id, readJson, wildcardMatch, writeJsonAtomic } from "./util.js"

export class PermissionBlockedError extends Error {
  constructor(
    public readonly permission: string,
    public readonly resources: string[],
    message: string,
  ) {
    super(message)
    this.name = "PermissionBlockedError"
  }
}

/** The user rejected with feedback; the tool should surface it as a failure to the model. */
export class PermissionRejectedError extends Error {
  constructor(public readonly feedback: string) {
    super(feedback)
    this.name = "PermissionRejectedError"
  }
}

/** The user declined without feedback; the harness stops the current turn. */
export class PermissionDeclinedError extends Error {
  constructor() {
    super("The user declined the permission request")
    this.name = "PermissionDeclinedError"
  }
}

export interface PermissionAsk {
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  message?: string
}

interface Pending {
  request: PermissionRequest
  resolve: (reply: PermissionReply, message?: string) => void
}

export interface PermissionEvents {
  onAsk(request: PermissionRequest): void
  onReply(sessionID: string, requestID: string, reply: PermissionReply): void
}

/** Windows paths are case-insensitive and may mix separators; normalize both sides. */
function normalizeResource(value: string): string {
  return process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value
}

export function evaluate(action: string, resource: string, rules: PermissionRule[]): PermissionRule {
  const value = normalizeResource(resource)
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (wildcardMatch(action, rule.action) && wildcardMatch(value, normalizeResource(rule.resource))) return rule
  }
  return { action, resource: "*", effect: "ask" }
}

export class PermissionEngine {
  private pending = new Map<string, Pending>()
  private saved: SavedPermissionStore

  constructor(
    dataDir: string,
    private config: Config,
    private events: PermissionEvents,
    db?: SqliteDb,
    /** Rules appended last: managed directories the app itself owns (data, temp, global config). */
    private managedRules: PermissionRule[] = [],
  ) {
    const jsonFile = path.join(dataDir, "permissions.json")
    this.saved = db
      ? createSqlitePermissionStore(db)
      : {
          all: () => Object.entries(readJson<Record<string, PermissionRule[]>>(jsonFile, {})).flatMap(([project, rules]) =>
            rules.map((rule) => ({ action: rule.action, resource: rule.resource, effect: "allow" as const, project })),
          ),
          rulesFor: (directory) => readJson<Record<string, PermissionRule[]>>(jsonFile, {})[directory] ?? [],
          add: (directory, action, resources) => {
            const saved = readJson<Record<string, PermissionRule[]>>(jsonFile, {})
            const rules = saved[directory] ?? []
            for (const resource of resources) rules.push({ action, resource, effect: "allow" })
            saved[directory] = rules
            writeJsonAtomic(jsonFile, saved)
          },
          clear: () => writeJsonAtomic(jsonFile, {}),
        }
  }

  updateConfig(config: Config): void {
    this.config = config
  }

  savedRules(directory: string): PermissionRule[] {
    return this.saved.rulesFor(directory)
  }

  allSaved(): SavedPermissionView[] {
    return this.saved.all().map((rule) => ({
      action: rule.action,
      resource: rule.resource,
      project: rule.project ?? "",
    }))
  }

  clearSaved(): void {
    this.saved.clear()
  }

  private addSaved(directory: string, action: string, resources: string[]): void {
    this.saved.add(directory, action, resources)
  }

  /** Agente + globales + sesión + gestionadas, en ese orden (última regla que hace match gana). */
  rules(agent: AgentDef, sessionPermissions?: PermissionRule[]): PermissionRule[] {
    return [...agent.permissions, ...this.config.permissions, ...(sessionPermissions ?? []), ...this.managedRules]
  }

  /** Full evaluation chain used by tools. Throws on deny; asks when needed. */
  async assert(
    input: PermissionAsk,
    agent: AgentDef,
    directory: string,
    sessionPermissions?: PermissionRule[],
    onAsk?: (request: PermissionRequest) => void,
    autoApprove = false,
  ): Promise<void> {
    const rules = this.rules(agent, sessionPermissions)
    const decision = this.decide(input.action, input.resources, rules)
    if (decision === "deny") {
      throw new PermissionBlockedError(input.action, input.resources, `Permission denied: ${input.action}`)
    }
    if (decision === "allow") return
    // Saved "always allow" rules only add allow effects on top of the configured rules.
    const withSaved = [...rules, ...this.savedRules(directory)]
    const stillAsked = input.resources.some((resource) => evaluate(input.action, resource, withSaved).effect !== "allow")
    if (!stillAsked) return
    if (autoApprove || this.config.autoApprove) return
    await this.ask(input, directory, onAsk)
  }

  private decide(action: string, resources: string[], rules: PermissionRule[]): "allow" | "deny" | "ask" {
    const denied = resources.some((resource) => evaluate(action, resource, rules).effect === "deny")
    if (denied) return "deny"
    const asked = resources.some((resource) => evaluate(action, resource, rules).effect === "ask")
    return asked ? "ask" : "allow"
  }

  async ask(input: PermissionAsk, directory?: string, onAsk?: (request: PermissionRequest) => void): Promise<void> {
    const request: PermissionRequest = {
      id: id("per"),
      sessionID: input.sessionID,
      action: input.action,
      resources: input.resources,
      save: input.save,
      metadata: input.metadata,
      message: input.message,
      time: Date.now(),
    }
    this.events.onAsk(request)
    onAsk?.(request)
    const reply = await new Promise<{ reply: PermissionReply; message?: string }>((resolve) => {
      this.pending.set(request.id, {
        request,
        resolve: (r, message) => resolve({ reply: r, message }),
      })
    })
    if (reply.reply === "reject") {
      if (reply.message?.trim()) throw new PermissionRejectedError(reply.message.trim())
      throw new PermissionDeclinedError()
    }
    if (reply.reply === "always") {
      const save = input.save && input.save.length > 0 ? input.save : input.resources
      if (directory) this.addSaved(directory, input.action, save)
    }
  }

  reply(requestID: string, reply: PermissionReply, message?: string): void {
    const entry = this.pending.get(requestID)
    if (!entry) return
    this.pending.delete(requestID)
    this.events.onReply(entry.request.sessionID, requestID, reply)
    entry.resolve(reply, message)
  }

  list(sessionID?: string): PermissionRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .filter((request) => !sessionID || request.sessionID === sessionID)
  }

  /** Called when a session is interrupted: rejects everything pending for it. */
  cancelSession(sessionID: string): void {
    for (const [requestID, entry] of this.pending) {
      if (entry.request.sessionID !== sessionID) continue
      this.pending.delete(requestID)
      this.events.onReply(sessionID, requestID, "reject")
      entry.resolve("reject")
    }
  }
}
