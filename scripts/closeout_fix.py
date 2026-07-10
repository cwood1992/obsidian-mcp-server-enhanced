#!/usr/bin/env python3
"""Supervised dirty-repo closeout runner for kit."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
import hashlib

import closeout_explanations


STATE_APP_DIR = "repo-contract-kit"
SIDECAR_DIR_KEYS = (
    "runs_dir",
    "receipts_dir",
    "review_artifacts_dir",
    "docs_patch_proposals_dir",
    "task_packets_dir",
    "feedback_dir",
    "automation_handoffs_dir",
    "quarantine_dir",
)
GIT_IDENTITY = [
    "-c",
    "user.name=kit closeout-fix",
    "-c",
    "user.email=kit-closeout-fix@example.invalid",
]
EVENTS_PAYLOAD_LIMIT = 800
CLOSEOUT_BLOCKED_EXIT = 2


EventSink = Callable[[dict[str, Any]], None]


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def artifact_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def state_base_dir() -> Path:
    xdg_state_home = os.environ.get("XDG_STATE_HOME")
    if xdg_state_home:
        return Path(xdg_state_home).expanduser().resolve() / STATE_APP_DIR
    return Path.home().expanduser().resolve() / ".local" / "state" / STATE_APP_DIR


def repo_slug(repo: Path) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", repo.name).strip(".-")
    return slug or "repo"


def repo_identity(repo: Path) -> dict[str, Any]:
    root = str(repo.resolve())
    stable_id = hashlib.sha256(root.encode("utf-8")).hexdigest()
    return {
        "root": root,
        "id": stable_id[:16],
        "hash_algorithm": "sha256",
        "hash": stable_id,
    }


def sidecar_state(repo: Path) -> dict[str, Any]:
    base = state_base_dir()
    identity = repo_identity(repo)
    repo_dir = base / f"{repo_slug(repo)}-{identity['id']}"
    return {
        "base_dir": str(base),
        "xdg_state_home": os.environ.get("XDG_STATE_HOME"),
        "repo": identity,
        "repo_state_dir": str(repo_dir),
        "available": repo_dir.exists(),
        "paths": {
            "runs_dir": str(repo_dir / "runs"),
            "receipts_dir": str(repo_dir / "receipts"),
            "review_artifacts_dir": str(repo_dir / "review-artifacts"),
            "docs_patch_proposals_dir": str(repo_dir / "docs-patch-proposals"),
            "task_packets_dir": str(repo_dir / "task-packets"),
            "feedback_dir": str(repo_dir / "feedback"),
            "automation_handoffs_dir": str(repo_dir / "automation-handoffs"),
            "quarantine_dir": str(repo_dir / "quarantine"),
            "status_json": str(repo_dir / "status.json"),
        },
        "created": False,
        "note": "Non-mutating closeout-fix previews report sidecar paths without creating them.",
    }


def write_json_file(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_text_file(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def ensure_sidecar(repo: Path, reason: str) -> tuple[dict[str, Any], list[str]]:
    before = sidecar_state(repo)
    repo_dir = Path(before["repo_state_dir"])
    created = not repo_dir.exists()
    paths = [repo_dir]
    for key in SIDECAR_DIR_KEYS:
        path = Path(before["paths"][key])
        path.mkdir(parents=True, exist_ok=True)
        paths.append(path)
    status_path = Path(before["paths"]["status_json"])
    status_payload = {
        "schema_version": 1,
        "repo": before["repo"],
        "paths": before["paths"],
        "created": created,
        "reason": reason,
        "updated_at": now(),
    }
    write_json_file(status_path, status_payload)
    paths.append(status_path)
    after = sidecar_state(repo)
    after["created"] = created
    after["note"] = "Sidecar directories are available for closeout-fix artifacts."
    return after, [str(path) for path in paths]


def target_repo_writes(performed: bool, paths: list[str] | None = None, reason: str | None = None) -> dict[str, Any]:
    return {
        "performed": performed,
        "paths": paths or [],
        "reason": reason or ("closeout-fix wrote target repo state" if performed else "preview/no target writes"),
    }


def sidecar_writes(performed: bool, paths: list[str] | None = None, reason: str | None = None) -> dict[str, Any]:
    return {
        "performed": performed,
        "paths": paths or [],
        "reason": reason or ("closeout-fix wrote sidecar state" if performed else "preview/no sidecar writes"),
    }


def run_command(
    command: list[str],
    cwd: Path,
    *,
    timeout: int | None = None,
    input_text: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
        env=env,
    )


def run_git(repo: Path, args: list[str], *, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return run_command(["git", *args], repo, timeout=timeout)


def run_git_with_identity(repo: Path, args: list[str], *, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return run_command(["git", *GIT_IDENTITY, *args], repo, timeout=timeout)


def git_text(repo: Path, args: list[str]) -> str:
    result = run_git(repo, args)
    return result.stdout.strip() if result.returncode == 0 else ""


def git_status_entries(repo: Path) -> list[str]:
    result = run_git(repo, ["status", "--short"])
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def current_head(repo: Path) -> str:
    return git_text(repo, ["rev-parse", "HEAD"])


def current_branch(repo: Path) -> str:
    return git_text(repo, ["branch", "--show-current"])


def commit_details(repo: Path, before_head: str, after_head: str) -> list[dict[str, Any]]:
    if not before_head or not after_head or before_head == after_head:
        return []
    revs = run_git(repo, ["rev-list", "--reverse", f"{before_head}..{after_head}"])
    if revs.returncode != 0:
        return []
    commits = []
    for commit in [line.strip() for line in revs.stdout.splitlines() if line.strip()]:
        subject = git_text(repo, ["show", "-s", "--format=%s", commit])
        files = run_git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
        commits.append(
            {
                "sha": commit,
                "short_sha": commit[:12],
                "subject": subject,
                "files": [line.strip() for line in files.stdout.splitlines() if line.strip()] if files.returncode == 0 else [],
            }
        )
    return commits


def extract_json_object(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        value = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def run_cli_json(cli_path: Path, repo: Path, args: list[str], timeout: int | None = None) -> tuple[dict[str, Any] | None, subprocess.CompletedProcess[str]]:
    command = [sys.executable, str(cli_path), *args]
    result = run_command(command, repo, timeout=timeout)
    return extract_json_object(result.stdout), result


def closeout_plan(cli_path: Path, repo: Path, *, strict: bool = False, timeout: int | None = None) -> tuple[dict[str, Any] | None, subprocess.CompletedProcess[str]]:
    args = ["closeout-plan", "--repo", str(repo), "--json"]
    if strict:
        args.append("--strict")
    return run_cli_json(cli_path, repo, args, timeout=timeout)


def worktree_prune(cli_path: Path, repo: Path, timeout: int | None = None) -> tuple[dict[str, Any] | None, subprocess.CompletedProcess[str]]:
    return run_cli_json(cli_path, repo, ["worktree", "prune", "--root", str(repo), "--apply", "--json"], timeout=timeout)


def codex_exec_automation_flags(binary: str) -> list[str]:
    try:
        result = subprocess.run(
            [binary, "exec", "--help"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        help_text = f"{result.stdout}\n{result.stderr}"
    except (OSError, subprocess.SubprocessError):
        help_text = ""
    if "--dangerously-bypass-approvals-and-sandbox" in help_text:
        return ["--dangerously-bypass-approvals-and-sandbox"]
    if "--ask-for-approval" in help_text:
        return ["--sandbox", "danger-full-access", "--ask-for-approval", "never"]
    return ["--sandbox", "danger-full-access"]


def resolve_runner(agent: str, agent_command: str | None) -> tuple[dict[str, Any], list[str]]:
    blockers: list[str] = []
    if agent == "custom":
        if not agent_command:
            return {"kind": "custom", "command": None, "available": False}, ["--agent custom requires --agent-command."]
        command = shlex.split(agent_command)
        binary = shutil.which(command[0]) if command else None
        if not binary:
            blockers.append(f"Custom agent command is not executable: {command[0] if command else agent_command}")
        return {
            "kind": "custom",
            "command": command,
            "available": not blockers,
            "binary": binary,
        }, blockers
    if agent in {"auto", "codex"}:
        binary = shutil.which("codex")
        if not binary:
            return {"kind": "codex", "command": None, "available": False}, ["codex executable was not found on PATH."]
        automation_flags = codex_exec_automation_flags(binary)
        return {
            "kind": "codex",
            "command": [
                binary,
                "exec",
                "--cd",
                "<repo>",
                *automation_flags,
                "--json",
                "-",
            ],
            "available": True,
            "binary": binary,
        }, []
    return {"kind": agent, "command": None, "available": False}, [f"Unsupported closeout-fix agent: {agent}"]


def runner_command(runner: dict[str, Any], repo: Path) -> list[str]:
    if runner.get("kind") == "codex":
        command = list(runner["command"])
        return [str(repo) if item == "<repo>" else item for item in command]
    return list(runner.get("command") or [])


def safe_excerpt(value: str, limit: int = EVENTS_PAYLOAD_LIMIT) -> str:
    value = value.strip()
    if len(value) <= limit:
        return value
    return value[:limit] + "..."


def emit(sink: EventSink | None, event: dict[str, Any]) -> None:
    if sink:
        sink({**event, "created_at": event.get("created_at") or now()})


def build_prompt(repo: Path, *, no_push: bool, initial_closeout: dict[str, Any] | None) -> str:
    completion_state = (initial_closeout or {}).get("completion_state") or "unknown"
    blockers = (initial_closeout or {}).get("claim_blockers") or []
    blocker_lines = "\n".join(
        f"- {item.get('code', 'blocker')}: {item.get('message', '')}" for item in blockers[:12]
    ) or "- none reported"
    push_line = "Do not push; the supervisor was invoked with --no-push." if no_push else "Do not push yourself; the supervisor will push after final strict closeout passes."
    return f"""You are a headless closeout agent for one dirty repository.

Repository: {repo}
Initial closeout state: {completion_state}
Initial blockers:
{blocker_lines}

Mission:
1. Run `kit closeout-plan --repo {shlex.quote(str(repo))} --json`.
2. Run `git status --short` and classify all dirty files into coherent logical lanes.
3. Preserve real work. Split each lane into an individual commit with a clear message.
4. Use kit task/status/finalizer/receipt commands to close task state when evidence exists.
5. Run kit update dry-run/apply only when the repo cleanliness and kit output say it is safe.
6. Run the clean disposable worktree prune flow only through kit commands.
7. Run `kit closeout-plan --repo {shlex.quote(str(repo))} --strict --json` before stopping.

Hard stops:
- Never run `git reset`, `git clean`, destructive checkout, stash/drop, or force-push.
- Never delete dirty worktrees or user source files.
- Never claim success unless strict closeout passes.
- Keep receipts durable and outside removable worktrees when task closeout needs evidence.
- {push_line}

Final response:
Return a concise summary of commits, receipts, pruned worktrees, remaining blockers, and final closeout status.
"""


def preview_payload(args: Any, repo: Path, cli_path: Path) -> tuple[dict[str, Any], int]:
    runner, runner_blockers = resolve_runner(args.agent, getattr(args, "agent_command", None))
    initial, result = closeout_plan(cli_path, repo, strict=False, timeout=args.timeout_seconds)
    blockers = list(runner_blockers)
    if initial is None:
        blockers.append("Unable to read initial closeout-plan JSON.")
    state = sidecar_state(repo)
    job_id = artifact_stamp()
    job_dir = Path(state["paths"]["runs_dir"]) / "closeout-fix" / job_id
    payload = {
        "schema_version": 1,
        "command": "closeout-fix",
        "mode": "preview",
        "job_id": job_id,
        "job_dir": str(job_dir),
        "repo": str(repo),
        "created_at": now(),
        "runner": runner,
        "initial_closeout": initial,
        "commits": [],
        "branches_pushed": [],
        "worktrees_pruned": [],
        "receipts": [],
        "final_closeout": None,
        "blockers": blockers,
        "result": "blocked" if blockers else "preview",
        "target_repo_writes": target_repo_writes(False, reason="closeout-fix preview performs no target writes"),
        "sidecar_writes": sidecar_writes(False, reason="closeout-fix preview performs no sidecar writes"),
        "sidecar_state": state,
        "next_command": f"kit closeout-fix --repo {shlex.quote(str(repo))} --apply --jsonl",
        "exit_code": CLOSEOUT_BLOCKED_EXIT if blockers else 0,
    }
    payload["blocker_explanations"] = closeout_explanations.explain_blockers(
        [{"code": "closeout_blocked", "message": blocker, "count": 1} for blocker in blockers]
    )
    payload["human_summary"] = closeout_explanations.closeout_fix_human_summary(payload)
    if result.returncode != 0 and initial is None:
        payload["initial_closeout_error"] = {
            "exit_code": result.returncode,
            "stderr": safe_excerpt(result.stderr),
            "stdout": safe_excerpt(result.stdout),
        }
    return payload, payload["exit_code"]


def sanitized_agent_event(job_id: str, line: str) -> dict[str, Any]:
    parsed = extract_json_object(line)
    payload: dict[str, Any] = {"event": "agent-output", "job_id": job_id, "text": safe_excerpt(line)}
    if parsed:
        payload["payload"] = parsed
    return payload


def run_agent(
    command: list[str],
    repo: Path,
    prompt: str,
    job_dir: Path,
    *,
    timeout: int,
    event_sink: EventSink | None,
    job_id: str,
) -> dict[str, Any]:
    raw_stdout = job_dir / "agent-stdout.jsonl"
    raw_stderr = job_dir / "agent-stderr.txt"
    env = {
        **os.environ,
        "KIT_CLOSEOUT_FIX": "1",
        "KIT_CLOSEOUT_FIX_REPO": str(repo),
        "KIT_CLOSEOUT_FIX_JOB_DIR": str(job_dir),
    }
    emit(event_sink, {"event": "runner-started", "job_id": job_id, "command": [command[0], *command[1:3]]})
    stderr_lines: list[str] = []
    emit_lock = threading.Lock()

    def emit_threadsafe(event: dict[str, Any]) -> None:
        with emit_lock:
            emit(event_sink, event)

    try:
        process = subprocess.Popen(
            command,
            cwd=repo,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
    except OSError as exc:
        message = str(exc)
        write_text_file(raw_stdout, "")
        write_text_file(raw_stderr, message)
        emit(event_sink, {"event": "agent-stderr", "job_id": job_id, "text": safe_excerpt(message)})
        return {
            "exit_code": 127,
            "timed_out": False,
            "stdout_path": str(raw_stdout),
            "stderr_path": str(raw_stderr),
            "stderr": safe_excerpt(message),
        }

    def capture_stdout() -> None:
        assert process.stdout is not None
        stream = process.stdout
        with raw_stdout.open("w", encoding="utf-8", errors="replace") as target:
            for line in stream:
                target.write(line)
                target.flush()
                if line.strip():
                    emit_threadsafe(sanitized_agent_event(job_id, line))
        stream.close()

    def capture_stderr() -> None:
        assert process.stderr is not None
        stream = process.stderr
        with raw_stderr.open("w", encoding="utf-8", errors="replace") as target:
            for line in stream:
                target.write(line)
                target.flush()
                stderr_lines.append(line)
                if line.strip():
                    emit_threadsafe({"event": "agent-stderr", "job_id": job_id, "text": safe_excerpt(line)})
        stream.close()

    stdout_thread = threading.Thread(target=capture_stdout, name="closeout-fix-agent-stdout", daemon=True)
    stderr_thread = threading.Thread(target=capture_stderr, name="closeout-fix-agent-stderr", daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    try:
        if process.stdin is not None:
            try:
                process.stdin.write(prompt)
                process.stdin.close()
            except BrokenPipeError:
                pass
        returncode = process.wait(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        returncode = 124
        timed_out = True
    finally:
        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)

    stderr = "".join(stderr_lines)
    if timed_out:
        timeout_message = "closeout-fix agent timed out"
        with raw_stderr.open("a", encoding="utf-8", errors="replace") as target:
            if stderr and not stderr.endswith("\n"):
                target.write("\n")
            target.write(timeout_message + "\n")
        emit(event_sink, {"event": "agent-stderr", "job_id": job_id, "text": timeout_message})
        stderr = "\n".join([value for value in [stderr.strip(), timeout_message] if value])
    return {
        "exit_code": returncode,
        "timed_out": timed_out,
        "stdout_path": str(raw_stdout),
        "stderr_path": str(raw_stderr),
        "stderr": safe_excerpt(stderr),
    }


def prune_from_closeout_plan(cli_path: Path, repo: Path, plan: dict[str, Any] | None, timeout: int) -> tuple[list[dict[str, Any]], dict[str, Any] | None, subprocess.CompletedProcess[str] | None, list[str]]:
    if not plan:
        return [], None, None, []
    worktree_prune_plan = plan.get("worktree_prune") or {}
    summary = worktree_prune_plan.get("summary") or {}
    unprotected = int(summary.get("unprotected_removable") or summary.get("would_remove") or 0)
    protected = int(summary.get("protected_removable") or 0)
    if protected:
        return [], None, None, ["Clean active or receipt-sensitive worktrees are protected from broad prune."]
    if unprotected <= 0:
        return [], None, None, []
    payload, result = worktree_prune(cli_path, repo, timeout=timeout)
    removed = []
    if payload:
        for item in payload.get("worktrees") or []:
            if item.get("prune_status") == "removed":
                removed.append({"path": item.get("root"), "branch": item.get("branch") or ""})
    blockers = []
    if result.returncode != 0:
        blockers.append("Worktree prune failed.")
    return removed, payload, result, blockers


def push_current_branch(repo: Path, timeout: int) -> tuple[dict[str, Any] | None, list[str]]:
    branch = current_branch(repo)
    if not branch:
        return None, ["Current checkout is detached; closeout-fix will not push detached HEAD."]
    upstream = git_text(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    if upstream:
        command = ["push"]
    else:
        remotes = [line.strip() for line in git_text(repo, ["remote"]).splitlines() if line.strip()]
        if "origin" not in remotes:
            return None, [f"Branch {branch} has no upstream and no origin remote; cannot push without explicit remote setup."]
        command = ["push", "-u", "origin", branch]
    result = run_git(repo, command, timeout=timeout)
    payload = {
        "branch": branch,
        "command": "git " + " ".join(command),
        "exit_code": result.returncode,
        "stdout": safe_excerpt(result.stdout),
        "stderr": safe_excerpt(result.stderr),
    }
    if result.returncode != 0:
        return payload, [f"git push failed for {branch}: {safe_excerpt(result.stderr or result.stdout)}"]
    return payload, []


def apply_payload(args: Any, repo: Path, cli_path: Path, event_sink: EventSink | None = None) -> tuple[dict[str, Any], int]:
    job_id = artifact_stamp()
    state, init_paths = ensure_sidecar(repo, "closeout-fix --apply")
    job_dir = Path(state["paths"]["runs_dir"]) / "closeout-fix" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = Path(state["paths"]["receipts_dir"]) / f"{job_id}-closeout-fix.json"
    result_path = job_dir / "result.json"
    prompt_path = job_dir / "mission.md"
    sidecar_paths = [*init_paths, str(job_dir), str(receipt_path), str(result_path)]
    emit(event_sink, {"event": "job-started", "job_id": job_id, "job_dir": str(job_dir), "repo": str(repo)})

    runner, runner_blockers = resolve_runner(args.agent, getattr(args, "agent_command", None))
    initial, initial_result = closeout_plan(cli_path, repo, strict=False, timeout=args.timeout_seconds)
    blockers = list(runner_blockers)
    if initial is None:
        blockers.append("Unable to read initial closeout-plan JSON.")
    before_head = current_head(repo)
    before_status = git_status_entries(repo)
    prompt = build_prompt(repo, no_push=bool(args.no_push), initial_closeout=initial)
    write_text_file(prompt_path, prompt)
    sidecar_paths.append(str(prompt_path))

    agent_result: dict[str, Any] | None = None
    worktrees_pruned: list[dict[str, Any]] = []
    prune_payload: dict[str, Any] | None = None
    final: dict[str, Any] | None = None
    branches_pushed: list[dict[str, Any]] = []
    target_paths: list[str] = []

    if not blockers:
        command = runner_command(runner, repo)
        agent_result = run_agent(
            command,
            repo,
            prompt,
            job_dir,
            timeout=args.timeout_seconds,
            event_sink=event_sink,
            job_id=job_id,
        )
        sidecar_paths.extend([agent_result["stdout_path"], agent_result["stderr_path"]])
        if agent_result["exit_code"] != 0:
            blockers.append(f"Agent runner exited non-zero: {agent_result['exit_code']}")

    after_agent_head = current_head(repo)
    commits = commit_details(repo, before_head, after_agent_head)
    if commits:
        target_paths.append(str(repo))

    if not blockers:
        pre_prune, _pre_prune_result = closeout_plan(cli_path, repo, strict=False, timeout=args.timeout_seconds)
        worktrees_pruned, prune_payload, _prune_result, prune_blockers = prune_from_closeout_plan(
            cli_path,
            repo,
            pre_prune,
            args.timeout_seconds,
        )
        blockers.extend(prune_blockers)
        if prune_payload:
            write_json_file(job_dir / "worktree-prune.json", prune_payload)
            sidecar_paths.append(str(job_dir / "worktree-prune.json"))
        if worktrees_pruned:
            target_paths.extend([item["path"] for item in worktrees_pruned if item.get("path")])
            emit(event_sink, {"event": "worktrees-pruned", "job_id": job_id, "count": len(worktrees_pruned)})

    final, final_result = closeout_plan(cli_path, repo, strict=True, timeout=args.timeout_seconds)
    if final is None:
        blockers.append("Unable to read final closeout-plan JSON.")
    elif final_result.returncode != 0:
        blockers.append("Final strict closeout-plan did not pass.")

    if not blockers and not args.no_push:
        push_result, push_blockers = push_current_branch(repo, args.timeout_seconds)
        if push_result:
            branches_pushed.append(push_result)
        blockers.extend(push_blockers)
        if not push_blockers:
            emit(event_sink, {"event": "branch-pushed", "job_id": job_id, "branch": push_result["branch"] if push_result else ""})

    result = "applied" if not blockers else "blocked"
    payload = {
        "schema_version": 1,
        "command": "closeout-fix",
        "mode": "apply",
        "job_id": job_id,
        "job_dir": str(job_dir),
        "result_path": str(result_path),
        "repo": str(repo),
        "created_at": now(),
        "runner": runner,
        "initial_closeout": initial,
        "initial_closeout_error": None
        if initial
        else {
            "exit_code": initial_result.returncode,
            "stderr": safe_excerpt(initial_result.stderr),
            "stdout": safe_excerpt(initial_result.stdout),
        },
        "agent_result": agent_result,
        "before": {
            "head": before_head,
            "status_entries": before_status,
        },
        "after": {
            "head": current_head(repo),
            "status_entries": git_status_entries(repo),
        },
        "commits": commits,
        "branches_pushed": branches_pushed,
        "worktrees_pruned": worktrees_pruned,
        "worktree_prune": prune_payload,
        "receipts": [{"path": str(receipt_path), "kind": "closeout-fix"}],
        "final_closeout": final,
        "blockers": blockers,
        "result": result,
        "no_push": bool(args.no_push),
        "target_repo_writes": target_repo_writes(bool(target_paths), paths=sorted(set(target_paths)), reason="agent commits, supervised prune, or push" if target_paths else "no target repo changes detected"),
        "sidecar_writes": sidecar_writes(True, paths=sorted(set(sidecar_paths)), reason="closeout-fix apply wrote job artifacts and receipt"),
        "sidecar_state": sidecar_state(repo),
        "exit_code": 0 if result == "applied" else CLOSEOUT_BLOCKED_EXIT,
    }
    payload["blocker_explanations"] = (
        (final or {}).get("blocker_explanations")
        or closeout_explanations.explain_blockers(
            [{"code": "closeout_blocked", "message": blocker, "count": 1} for blocker in blockers]
        )
    )
    payload["human_summary"] = closeout_explanations.closeout_fix_human_summary(payload)
    write_json_file(receipt_path, payload)
    write_json_file(result_path, payload)
    emit(
        event_sink,
        {
            "event": "job-finished",
            "job_id": job_id,
            "result": result,
            "receipt": str(receipt_path),
            "result_path": str(result_path),
            "exit_code": payload["exit_code"],
            "summary": payload["human_summary"],
        },
    )
    emit(event_sink, {"event": "job-completed", "job_id": job_id, "result": result, "receipt": str(receipt_path), "exit_code": payload["exit_code"]})
    return payload, payload["exit_code"]


def failure_payload(args: Any, repo: Path, exc: BaseException, event_sink: EventSink | None = None) -> tuple[dict[str, Any], int]:
    job_id = artifact_stamp()
    message = safe_excerpt(str(exc) or exc.__class__.__name__)
    mode = "apply" if getattr(args, "apply", False) else "preview"
    sidecar_paths: list[str] = []
    state = sidecar_state(repo)
    job_dir = Path(state["paths"]["runs_dir"]) / "closeout-fix" / job_id
    result_path = job_dir / "result.json"

    sidecar_performed = False
    if mode == "apply":
        state, init_paths = ensure_sidecar(repo, "closeout-fix failure")
        job_dir = Path(state["paths"]["runs_dir"]) / "closeout-fix" / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        result_path = job_dir / "result.json"
        sidecar_paths = [*init_paths, str(job_dir), str(result_path)]
        sidecar_performed = True

    payload = {
        "schema_version": 1,
        "command": "closeout-fix",
        "mode": mode,
        "job_id": job_id,
        "job_dir": str(job_dir),
        "result_path": str(result_path) if sidecar_performed else None,
        "repo": str(repo),
        "created_at": now(),
        "runner": None,
        "initial_closeout": None,
        "agent_result": None,
        "commits": [],
        "branches_pushed": [],
        "worktrees_pruned": [],
        "receipts": [],
        "final_closeout": None,
        "blockers": [f"closeout-fix failed before a normal terminal payload: {message}"],
        "result": "failed",
        "target_repo_writes": target_repo_writes(False, reason="closeout-fix failed before supervised target writes could be confirmed"),
        "sidecar_writes": sidecar_writes(sidecar_performed, paths=sorted(set(sidecar_paths)), reason="closeout-fix failure payload" if sidecar_performed else "preview/no sidecar writes"),
        "sidecar_state": state,
        "exit_code": 1,
    }
    payload["blocker_explanations"] = closeout_explanations.explain_blockers(
        [{"code": "external_blockers", "message": payload["blockers"][0], "count": 1}]
    )
    payload["human_summary"] = {
        "title": "Guided closeout failed",
        "status": "failed",
        "plain_reason": "The closeout supervisor failed before it could produce a normal applied or blocked result.",
        "why_it_blocks": "Kit cannot know what the guided workflow completed, so it treats the run as a tool failure rather than workflow evidence.",
        "recommended_action": "Inspect the job output or rerun the closeout preview before trying apply mode again.",
        "safe_next_command": f"kit closeout-fix --repo {shlex.quote(str(repo))} --json",
        "completed": [],
        "remaining": [
            {
                "code": "external_blockers",
                "title": "Closeout supervisor failure",
                "category": "tooling_or_policy",
                "count": 1,
            }
        ],
    }
    if sidecar_performed:
        write_json_file(result_path, payload)
    emit(
        event_sink,
        {
            "event": "job-finished",
            "job_id": job_id,
            "result": "failed",
            "result_path": str(result_path) if sidecar_performed else None,
            "exit_code": 1,
            "summary": payload["human_summary"],
        },
    )
    return payload, 1


def render_text(payload: dict[str, Any]) -> str:
    lines = [
        f"kit closeout-fix for {payload['repo']}:",
        f" - mode: {payload['mode']}",
        f" - result: {payload['result']}",
        f" - runner: {(payload.get('runner') or {}).get('kind') or 'unknown'}",
        f" - job: {payload['job_dir']}",
        f" - commits: {len(payload.get('commits') or [])}",
        f" - pruned worktrees: {len(payload.get('worktrees_pruned') or [])}",
        f" - pushed branches: {len(payload.get('branches_pushed') or [])}",
    ]
    if payload.get("blockers"):
        lines.append(" - blockers:")
        lines.extend(f"   - {blocker}" for blocker in payload["blockers"])
    summary = payload.get("human_summary") or {}
    if summary:
        lines.append(" - explanation:")
        lines.append(f"   - {summary.get('title')}: {summary.get('plain_reason')}")
        if summary.get("why_it_blocks"):
            lines.append(f"   - why: {summary.get('why_it_blocks')}")
        if summary.get("recommended_action"):
            lines.append(f"   - how to address: {summary.get('recommended_action')}")
    if payload.get("receipts"):
        lines.append(" - receipts:")
        lines.extend(f"   - {item.get('path')}" for item in payload["receipts"])
    if payload.get("mode") == "preview":
        lines.append(f" - apply: {payload.get('next_command')}")
    return "\n".join(lines)
