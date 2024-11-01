const PROMPTS_FILE = "node_modules/.swc-plugin-use-prompt/prompts";
const CHANGES_FILE = "node_modules/.swc-plugin-use-prompt/changes";

import env from "@next/env";
env.loadEnvConfig(process.cwd());

/** @typedef {import('@swc/core').Module} Module */
/** @typedef {import('@swc/core').FunctionDeclaration} FunctionDeclaration */
/** @typedef {import('@swc/core').FunctionExpression} FunctionExpression */
/** @typedef {import('@swc/core').Span} Span */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Compiler } from "@swc/core";
import { Command, Option } from "commander";
import watch from "glob-watcher";
import OpenAI from "openai";

/**
 * really bad not-visitor-pattern, but im def not coding every single variant
 * for something as unhinged as this.
 * @param {object} root
 * @returns {(FunctionDeclaration | FunctionExpression)[]}
 */
function findFunctionDecls(root) {
  const found = [];

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current !== "object" || current === null) continue;

    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    )
      found.push(current);

    stack.push(...Object.values(current));
  }

  return found;
}

const compiler = new Compiler();
/**
 * Find all uses of the `use prompt` directive in the given source.
 * Extract their associated positions and prompts.
 * @param {string} source
 * @returns {Promise<null | {span: Span, prompt: string, signature: string}[]>}
 */
async function identifyPromptRequests(source) {
  /** @type {Module} */
  let module;
  try {
    module = compiler.parseSync(source, {
      syntax: "typescript",
      tsx: true,
      isModule: true,
    });
  } catch (e) {
    console.error(e);
    return null;
  }

  const decls = findFunctionDecls(module).filter((decl) => decl.body);
  const prompts = decls
    .map((decl) => {
      decl.span.start -= module.span.start - 1;
      decl.span.end -= module.span.start - 1;
      decl.body.span.start -= module.span.start - 1;
      decl.body.span.end -= module.span.start - 1;
      const prologue = [];
      for (let expr of decl.body.stmts) {
        if (expr.type !== "ExpressionStatement") break;
        if (expr.expression.type !== "StringLiteral") break;
        prologue.push(expr.expression.value);
      }

      for (let string of prologue) {
        if (!string.startsWith("use prompt:")) continue;
        const prompt = string.slice(11).trim();
        if (!prompt.length) continue;
        return { decl, prompt };
      }
    })
    .filter(Boolean);

  const requests = prompts.map(({ decl, prompt }) => {
    const headerStart = decl.span.start - 1;
    const headerEnd = decl.body.span.start - 1;
    const signature = source.slice(headerStart, headerEnd) + "{}";
    return {
      span: decl.span,
      prompt,
      signature,
    };
  });
  return requests;
}

const SYSTEM_PROMPT = `You are an expert React developer. Generate code that strictly adheres to the function signature provided. Do not generate additional functions. Exclude the function header from your response.

If you require any additional imports, include that in your response specifying exactly which functions and components need to be imported. Do not include an import for the React global.

The codebase is a NextJS project using the App Router. There is no support for Tailwind.`;

/**
 * Call OpenAI for a given prompt and parse out the results.
 * @param {import('openai').OpenAI} openai
 * @param {string} source
 * @param {string} prompt
 * @param {string} signature
 * @returns {Promise<null | {code:string, imports: string | null}>}
 */
async function getPromptResults(openai, source, prompt, signature) {
  try {
    const rawResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "This is the full source file:\n\n" +
                "```tsx\n" +
                "import React from 'react';\n" +
                source +
                "\n```\n\n" +
                `Generate code to meet these requirements: ${prompt}` +
                "\n\n" +
                `It must strictly follow this function header: \`${signature}\`.` +
                "\n\n" +
                `Make sure to include the required library imports in a separate key. Do not include the function header your response.`,
            },
          ],
        },
      ],
      temperature: 1,
      max_tokens: 2048,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "generated_code",
          strict: true,
          schema: {
            type: "object",
            required: ["code", "imports"],
            properties: {
              code: {
                type: "string",
                description:
                  "The generated code as a string, excluding the function header.",
              },
              imports: {
                type: "string",
                description: "Imports required, or an empty string if none.",
              },
            },
            additionalProperties: false,
          },
        },
      },
    });
    const res = rawResponse.choices[0];
    if (res.finish_reason !== "stop") return null;
    let { code, imports } = JSON.parse(res.message.content);
    return { code, imports };
  } catch (e) {
    console.error(e);
    return null;
  }
}

/**
 * Identify all `use prompt`s in the changed file, then call OpenAI to run
 * codegen
 * @param {string} filePath
 * @param {import('openai').OpenAI} openai
 * @returns {Promise<null | {span: Span, prompt: string, value: {code: string, imports: null | string}}}
 */
async function getUpdatedCodegen(filePath, openai) {
  const source = (await fs.readFile(filePath)).toString();
  if (!(await shouldHandleFile(filePath, source))) return;
  console.log(`🤖 ${filePath} ...`);
  const requests = await identifyPromptRequests(source);
  if (!requests) return null;
  return (
    await Promise.all(
      requests.map(async ({ prompt, signature, span }) => ({
        span,
        prompt,
        value: await getPromptResults(openai, source, prompt, signature),
      })),
    )
  ).filter(Boolean);
}

function hashDigest(contents) {
  return crypto.createHash("sha256").update(contents, "utf8").digest("hex");
}

let changes;

try {
  changes = JSON.parse(fsC.readFile(CHANGES_FILE).toString());
} catch (e) {
  changes = {};
}

async function shouldHandleFile(filePath, contents) {
  const hash = hashDigest(contents);
  // console.log(filePath, hash);

  let should = false;
  if (changes[filePath] !== hash) {
    changes[filePath] = hash;
    should = true;
    await fs.writeFile(CHANGES_FILE, JSON.stringify(changes));
  }

  return should;
}

let prompts;
try {
  prompts = JSON.parse(fsC.readFile(PROMPTS_FILE).toString());
} catch (e) {
  prompts = {};
}

async function updatePromptsFile(updates) {
  for (let { span, prompt, value } of updates) {
    // console.log(span, prompt, value);
    if (!prompts[span.start]) prompts[span.start] = {};
    if (!prompts[span.start][span.end]) prompts[span.start][span.end] = {};
    prompts[span.start][span.end][prompt] = value;
  }

  await fs.writeFile(PROMPTS_FILE, JSON.stringify(prompts));
}

async function initialize({ patterns, apiKey }) {
  console.log(`👀 Watching ${patterns.join(", ")}`);

  await fs.mkdir(path.dirname(PROMPTS_FILE), { recursive: true });
  const openai = new OpenAI({ apiKey });

  const watcher = watch(patterns, { ignoreInitial: false });

  async function processPath(path) {
    const updates = await getUpdatedCodegen(path, openai);
    if (!updates) {
      return;
    }
    await updatePromptsFile(updates);
    await fs.utimes(path, new Date(), new Date());
    console.log(`✅ ${path} is  ✨ e n h a n c e d ✨`);
  }
  watcher.on("add", processPath);
  watcher.on("change", processPath);
}

const program = new Command();
program
  .name("use-prompt")
  .description(
    "Compile-time GenAI!\n\nPre-build step to parse prompts and generate an intermediate cache file.",
  )
  .addOption(
    new Option("-k, --api-key <string>", "openai api key").env(
      "OPENAI_API_KEY",
    ),
  )
  .addOption(
    new Option("-p, --patterns <patterns...>", "patterns to watch").default([
      "app/**/*.{tsx,jsx,ts,js}",
      "src/**/*.{tsx,jsx,ts,js}",
    ]),
  )
  .action(initialize);

program.parse();
