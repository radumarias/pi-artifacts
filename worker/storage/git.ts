import git from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs.ts";

/** Artifacts hands out tokens as `<secret>?expires=<unix seconds>`; Git authenticates with the secret alone. */
export function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

export type GitHttp = typeof webHttp;

interface CommitInput {
  remote: string;
  /** A repo-scoped write token. Artifacts appends `?expires=…`; Git wants only the secret. */
  token: string;
  branch: string;
  /** True for a repo with no commits yet: start a fresh history instead of cloning. */
  empty: boolean;
  /** Files to write, by repo path. Files not named here are kept as they are. */
  files: Record<string, string>;
  message: string;
  /** A tag to create on the new commit and push with it. */
  tag: string;
  /** Unix milliseconds for the commit's timestamps. */
  at: number;
  /** Tests point this at a local Git server; Workers use fetch. */
  http?: GitHttp;
}

const DIR = "/repo";
const AUTHOR = { name: "pi-artifacts", email: "agent@pi-artifacts.invalid" };

/**
 * One commit on top of the branch, pushed. A Worker has no git binary and no
 * disk, so this is isomorphic-git on an in-memory filesystem holding a
 * depth-1 checkout.
 */
export async function commitAndPush(input: CommitInput): Promise<void> {
  const fs = new MemoryFS();
  const http = input.http ?? webHttp;
  const secret = tokenSecret(input.token);
  const onAuth = () => ({ username: "x", password: secret });

  if (input.empty) {
    await git.init({ fs, dir: DIR, defaultBranch: input.branch });
    await git.addRemote({ fs, dir: DIR, remote: "origin", url: input.remote });
  } else {
    await git.clone({ fs, http, dir: DIR, url: input.remote, ref: input.branch, singleBranch: true, depth: 1, noTags: true, onAuth });
  }

  for (const [path, contents] of Object.entries(input.files)) {
    await fs.promises.writeFile(`${DIR}/${path}`, contents);
    await git.add({ fs, dir: DIR, filepath: path });
  }
  const identity = { ...AUTHOR, timestamp: Math.floor(input.at / 1000), timezoneOffset: 0 };
  await git.commit({ fs, dir: DIR, message: input.message, author: identity, committer: identity });
  await git.tag({ fs, dir: DIR, ref: input.tag });

  for (const ref of [input.branch, input.tag]) {
    const result = await git.push({ fs, http, dir: DIR, remote: "origin", ref, onAuth });
    if (!result.ok) throw new Error(`Push of ${ref} was refused: ${result.error ?? JSON.stringify(result.refs)}`);
  }
}
