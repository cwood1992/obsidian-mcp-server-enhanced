#!/usr/bin/env python3

from __future__ import annotations

from typing import Any

from _agent_scope import paths_overlap


STATUS_COMMAND = "make agent-task-status TASK_STATUS_INCLUDE_CLOSED=1 TASK_STATUS_JSON=1"
CLEANUP_COMMAND = "make agent-task-cleanup TASK_CLEANUP_JSON=1"


def task_id(task: dict[str, Any]) -> str:
    return str(task.get("task_id") or task.get("id") or "unknown")


def task_scope(task: dict[str, Any]) -> list[str]:
    scope = task.get("scope")
    return list(scope) if isinstance(scope, list) else []


def scopes_overlap(left: list[str], right: list[str]) -> bool:
    if not left or not right:
        return False
    return any(paths_overlap(a, b) for a in left for b in right)


def task_matches_requested_scope(task: dict[str, Any], requested_scope: list[str] | None) -> bool:
    if requested_scope is None:
        return True
    scope = task_scope(task)
    if not scope:
        return True
    return scopes_overlap(scope, requested_scope)


def task_next_safe_command(task: dict[str, Any]) -> str:
    current = task_id(task)
    if task.get("dirty"):
        return f"make agent-task-ready TASK={current} TASK_READY_JSON=1"
    if task.get("lease_expired") or not task.get("worktree_exists") or not task.get("worktree_registered"):
        return "make agent-task-status TASK_STATUS_STRICT=1"
    if task.get("status") == "in-progress":
        return f"make agent-task-ready TASK={current} TASK_READY_JSON=1"
    return STATUS_COMMAND


def active_task_brief(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": task_id(task),
        "status": task.get("status") or "unknown",
        "scope": task_scope(task),
        "owner": task.get("owner"),
        "owner_label": task.get("owner_label"),
        "session_id": task.get("session_id"),
        "thread_id": task.get("thread_id"),
        "automation_id": task.get("automation_id"),
        "attribution": task.get("attribution"),
        "worktree": task.get("worktree") or "",
        "worktree_exists": bool(task.get("worktree_exists")),
        "worktree_registered": bool(task.get("worktree_registered")),
        "dirty": task.get("dirty"),
        "lease_expires_at": task.get("lease_expires_at"),
        "lease_expired": bool(task.get("lease_expired")),
        "final_receipt": task.get("final_receipt"),
        "warnings": list(task.get("warnings") or []),
        "next_safe_command": task_next_safe_command(task),
    }


def coordination_item(code: str, message: str, task: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "code": code,
        "message": message,
        "next_command": extra.pop("next_command", STATUS_COMMAND),
    }
    if task is not None:
        payload.update(
            {
                "task_id": task_id(task),
                "scope": task_scope(task),
                "worktree": task.get("worktree") or "",
                "attribution": task.get("attribution"),
            }
        )
    payload.update(extra)
    return payload


def recommended_next_command(blockers: list[dict[str, Any]], warnings: list[dict[str, Any]]) -> str:
    for item in blockers:
        command = item.get("next_command")
        if command:
            return str(command)
    warning_codes = {item.get("code") for item in warnings}
    if warning_codes & {"stale_task", "dirty_task_worktree", "unregistered_task_worktree", "missing_task_worktree"}:
        return STATUS_COMMAND
    if warning_codes & {"untracked_agent_worktree"}:
        return CLEANUP_COMMAND
    return "make agent-task-prepare TASK=<id> SCOPE=<paths>"


def build_parallel_context(report: dict[str, Any], requested_scope: list[str] | None = None) -> dict[str, Any]:
    tasks = report.get("tasks", []) if isinstance(report.get("tasks"), list) else []
    active = [task for task in tasks if task.get("status") == "in-progress"]
    blockers: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    for hazard in report.get("hazards", []) or []:
        tasks_by_id = {task_id(task): task for task in active}
        hazard_tasks = [tasks_by_id.get(str(item)) for item in hazard.get("tasks", [])]
        if requested_scope is not None and not any(
            task is not None and task_matches_requested_scope(task, requested_scope)
            for task in hazard_tasks
        ):
            warnings.append(
                {
                    "code": "unrelated_scope_overlap",
                    "message": hazard.get("message") or "Unrelated active tasks overlap each other.",
                    "tasks": hazard.get("tasks", []),
                    "paths": hazard.get("paths", []),
                    "next_command": STATUS_COMMAND,
                }
            )
            continue
        blockers.append(
            {
                "code": "active_scope_overlap",
                "message": hazard.get("message") or "Active task scopes overlap.",
                "tasks": hazard.get("tasks", []),
                "paths": hazard.get("paths", []),
                "attributions": hazard.get("attributions", []),
                "next_command": STATUS_COMMAND,
            }
        )

    for task in active:
        same_scope = task_matches_requested_scope(task, requested_scope)
        scope = task_scope(task)
        if requested_scope is not None and scope and scopes_overlap(scope, requested_scope):
            blockers.append(
                coordination_item(
                    "active_scope_overlap",
                    f"Requested scope overlaps active task {task_id(task)}.",
                    task,
                )
            )
        if not scope:
            blockers.append(
                coordination_item(
                    "unknown_task_scope",
                    f"Active task {task_id(task)} has unknown scope, so a new write task could collide.",
                    task,
                )
            )
        if not task.get("worktree_exists"):
            item = coordination_item("missing_task_worktree", f"Task {task_id(task)} metadata references a missing worktree.", task)
            (blockers if same_scope else warnings).append(item)
        elif not task.get("worktree_registered"):
            item = coordination_item("unregistered_task_worktree", f"Task {task_id(task)} worktree is not registered by git.", task)
            (blockers if same_scope else warnings).append(item)
        if task.get("dirty"):
            item = coordination_item("dirty_task_worktree", f"Task {task_id(task)} worktree has uncommitted changes.", task)
            (blockers if same_scope else warnings).append(item)
        if task.get("lease_expired"):
            code = "stale_same_scope_task" if same_scope else "stale_task"
            item = coordination_item(code, f"Task {task_id(task)} lease has expired.", task)
            (blockers if same_scope else warnings).append(item)

    for item in report.get("untracked_agent_worktrees", []) or []:
        payload = {
            "code": "untracked_agent_worktree",
            "message": "A registered agent worktree has no task metadata, so its scope is unknown.",
            "worktree": item.get("path"),
            "branch": item.get("branch"),
            "attribution": item.get("attribution"),
            "next_command": CLEANUP_COMMAND,
        }
        (blockers if requested_scope is not None else warnings).append(payload)

    deduped_blockers = dedupe_items(blockers)
    deduped_warnings = dedupe_items(warnings)
    return {
        "schema_version": 1,
        "source_command": STATUS_COMMAND,
        "requested_scope": requested_scope or [],
        "active_task_count": len(active),
        "active_tasks": [active_task_brief(task) for task in active],
        "blockers": deduped_blockers,
        "warnings": deduped_warnings,
        "blocker_count": len(deduped_blockers),
        "warning_count": len(deduped_warnings),
        "can_start_write_task": not deduped_blockers,
        "recommended_next_command": recommended_next_command(deduped_blockers, deduped_warnings),
    }


def dedupe_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    deduped: list[dict[str, Any]] = []
    for item in items:
        key = (
            item.get("code"),
            item.get("task_id"),
            item.get("worktree"),
            tuple(item.get("tasks") or []),
            item.get("message"),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped
