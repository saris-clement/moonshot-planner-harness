import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  logPath?: string;
  allowFailure?: boolean;
  maxCapturedBytes?: number;
  onStdout?: (chunk: Buffer) => void;
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number, maximum: number): number {
  if (currentBytes >= maximum) return currentBytes;
  const remaining = maximum - currentBytes;
  const value = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(value);
  return currentBytes + value.byteLength;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  const maxCapturedBytes = options.maxCapturedBytes ?? 5 * 1_024 * 1_024;
  if (options.logPath) await mkdir(path.dirname(options.logPath), { recursive: true });
  const log = options.logPath ? createWriteStream(options.logPath, { flags: 'a' }) : null;

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let callbackError: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };

    child.stdout.on('data', (value: Buffer) => {
      stdoutBytes = appendBounded(stdout, value, stdoutBytes, maxCapturedBytes);
      log?.write(value);
      if (!callbackError) {
        try {
          options.onStdout?.(value);
        } catch (error) {
          callbackError = error instanceof Error ? error : new Error(String(error));
          kill('SIGKILL');
        }
      }
    });
    child.stderr.on('data', (value: Buffer) => {
      stderrBytes = appendBounded(stderr, value, stderrBytes, maxCapturedBytes);
      log?.write(value);
    });

    child.once('error', (error) => {
      log?.end();
      reject(error);
    });

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill('SIGTERM');
          killTimer = setTimeout(() => kill('SIGKILL'), 5_000);
        }, options.timeoutMs)
      : undefined;

    child.once('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      log?.end();
      const result: CommandResult = {
        command,
        args: [...args],
        exitCode: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
      };
      if (callbackError) {
        reject(callbackError);
      } else if (timedOut) {
        reject(new Error(`command timed out after ${options.timeoutMs}ms: ${formatCommand(command, args)}`));
      } else if (result.exitCode !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `command failed (${result.exitCode}): ${formatCommand(command, args)}\n${result.stderr.slice(-4_000)}`,
          ),
        );
      } else {
        resolve(result);
      }
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((value) => (/^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}
