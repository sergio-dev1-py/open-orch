import { readdirSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { skillContent } from "../skills.js"
import { textOutput, ToolFailure, type ToolContext, type ToolDefinition } from "./types.js"

// ---------------------------------------------------------------------------
// subagent
// ---------------------------------------------------------------------------

const SUBAGENT_DESCRIPTION = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const subagentTool: ToolDefinition = {
  name: "subagent",
  description: SUBAGENT_DESCRIPTION,
  inputSchema: z.object({
    agent: z
      .string()
      .describe(
        "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
      ),
    description: z.string().describe("A short 3-5 word label for the task, displayed to the user"),
    prompt: z.string().describe("The task for the subagent to perform"),
    model: z
      .string()
      .optional()
      .describe(
        'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
      ),
    sessionID: z
      .string()
      .optional()
      .describe("Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation."),
    background: z
      .boolean()
      .optional()
      .describe("Run the subagent in the background and return immediately. You will be notified when it finishes. DO NOT sleep, poll, or proactively check on its progress."),
  }),
  async execute(
    input: { agent: string; description: string; prompt: string; model?: string; sessionID?: string; background?: boolean },
    ctx: ToolContext,
  ) {
    const available = ctx.services.subagents()
    const known = available.find((agent) => agent.id === input.agent)
    if (!known) {
      throw new ToolFailure(
        `Unknown subagent "${input.agent}". Available subagents: ${available.map((agent) => agent.id).join(", ") || "(none)"}`,
      )
    }
    await ctx.permission({ action: "subagent", resources: [input.agent], save: [input.agent] })
    const result = await ctx.services.spawnSubagent({
      parentSessionID: ctx.sessionID,
      agent: input.agent,
      prompt: input.prompt,
      description: input.description,
      model: input.model,
      sessionID: input.sessionID,
      background: input.background,
    })
    if (result.status === "running") {
      return textOutput(
        `The subagent is working in the background (sessionID: ${result.sessionID}${result.model ? `, model: ${result.model}` : ""}). You will be notified automatically when it finishes.\nDO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.\nWork on non-overlapping tasks, or briefly tell the user what you launched and end your response.`,
        { sessionID: result.sessionID, background: true, agent: input.agent, model: result.model },
      )
    }
    return textOutput(`<subagent sessionID="${result.sessionID}" state="completed">\n${result.output}\n</subagent>`, {
      sessionID: result.sessionID,
      agent: input.agent,
      output: result.output,
      model: result.model,
    })
  },
}

export function subagentDescription(base: string, subagents: { id: string; description: string }[]): string {
  if (subagents.length === 0) return base
  const lines = subagents.map(
    (agent) => `- ${agent.id}: ${agent.description || "This subagent should only be called when explicitly requested."}`,
  )
  return `${base}\n\nAvailable subagents:\n${lines.join("\n")}`
}

// ---------------------------------------------------------------------------
// question
// ---------------------------------------------------------------------------

export const questionTool: ToolDefinition = {
  name: "question",
  description: `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`,
  inputSchema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().describe("Complete question"),
          header: z.string().describe("Very short label (max 30 chars)"),
          options: z
            .array(
              z.object({
                label: z.string().describe("Display text (1-5 words, concise)"),
                description: z.string().describe("Explanation of choice"),
              }),
            )
            .describe("Available choices"),
          multiple: z.boolean().optional().describe("Allow selecting more than one option"),
        }),
      )
      .min(1),
  }),
  async execute(input: { questions: { question: string; header: string; options: { label: string; description?: string }[]; multiple?: boolean }[] }, ctx: ToolContext) {
    await ctx.permission({ action: "question", resources: ["*"] })
    const answers = await ctx.services.ask(ctx.sessionID, input.questions)
    const parts = input.questions.map((question) => {
      const answer = answers.find((entry) => entry.question === question.question)
      const value = answer && answer.answers.length > 0 ? answer.answers.join(", ") : "Unanswered"
      return `"${question.question}"="${value}"`
    })
    return textOutput(`User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`, {
      answers,
    })
  },
}

// ---------------------------------------------------------------------------
// skill
// ---------------------------------------------------------------------------

export const skillTool: ToolDefinition = {
  name: "skill",
  description: `Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.

The skill ID must match an available skill or a skill explicitly referenced by the user.`,
  inputSchema: z.object({
    id: z.string().describe("The ID of an available skill or a skill explicitly referenced by the user"),
  }),
  async execute(input: { id: string }, ctx: ToolContext) {
    const skills = ctx.services.skills(ctx.sessionID)
    const skill = skills.find((entry) => entry.id === input.id)
    if (!skill) {
      throw new ToolFailure(`Unable to load skill ${input.id}: not found. Available skills: ${skills.map((entry) => entry.id).join(", ") || "(none)"}`)
    }
    await ctx.permission({ action: "skill", resources: [skill.id], save: [skill.id] })
    return textOutput(skillContent(skill), { skill: skill.id, directory: skill.directory })
  },
}
