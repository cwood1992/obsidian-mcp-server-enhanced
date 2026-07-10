"""Human-facing explanations for closeout blockers."""

from __future__ import annotations

from typing import Any


BLOCKER_EXPLANATIONS: dict[str, dict[str, str]] = {
    "dirty_primary_checkout": {
        "category": "repo_work",
        "title": "Uncommitted source changes",
        "plain_reason": "The primary checkout still has uncommitted source changes.",
        "why_it_blocks": "Kit cannot tell whether those files are work to keep, work to hand off, or residue to remove.",
        "recommended_action": "Inspect the dirty files, then preserve real work in commits or hand it off with a durable receipt.",
        "safe_next_command": "git status --short",
        "automation_level": "human_review_required",
    },
    "worktree_prune_candidates": {
        "category": "sibling_worktrees",
        "title": "Clean disposable worktrees can be pruned",
        "plain_reason": "Kit found clean disposable task worktrees that are safe candidates for the prune lane.",
        "why_it_blocks": "Leaving stale disposable worktrees around makes it unclear which task surfaces still matter.",
        "recommended_action": "Run the reported prune dry run, review the candidates, then apply the kit prune command if the list is correct.",
        "safe_next_command": "kit worktree prune --root <repo> --dry-run --json",
        "automation_level": "agent_can_prepare",
    },
    "worktree_prune_blocked": {
        "category": "sibling_worktrees",
        "title": "Some disposable worktrees are blocked",
        "plain_reason": "One or more disposable worktrees cannot be pruned automatically, usually because they are dirty.",
        "why_it_blocks": "Kit refuses to remove worktrees that may contain uncommitted or unreviewed work.",
        "recommended_action": "Inspect the blocked worktrees and either integrate, receipt, or explicitly keep their work.",
        "safe_next_command": "kit worktree audit --root <repo> --json",
        "automation_level": "human_review_required",
    },
    "active_worktree_prune_risk": {
        "category": "sibling_worktrees",
        "title": "Active worktree prune risk",
        "plain_reason": "A clean active task worktree exists, but it is still protected from broad pruning.",
        "why_it_blocks": "The task may still need handoff or receipt evidence even if its files are clean.",
        "recommended_action": "Finalize or hand off the active task before pruning its worktree.",
        "safe_next_command": "make agent-task-status TASK_STATUS_STRICT=1",
        "automation_level": "human_review_required",
    },
    "kit_managed_review": {
        "category": "kit_update_review",
        "title": "Kit managed updates need review",
        "plain_reason": "Kit generated managed-file proposals that still need to be accepted, rejected, or receipted.",
        "why_it_blocks": "These proposals are not Git dirt, but Kit cannot claim the repo is closed out while update decisions are pending.",
        "recommended_action": "Review the latest .doc-contract-kit/updates report and record the decision for each proposal.",
        "safe_next_command": "kit update --dry-run --repo <repo>",
        "automation_level": "human_review_required",
    },
    "active_tasks": {
        "category": "task_evidence",
        "title": "Tasks still in progress",
        "plain_reason": "One or more task records are still marked in progress.",
        "why_it_blocks": "Kit cannot call the repo finished while active task metadata says work is still underway.",
        "recommended_action": "Run task status, then finish, block, or abandon each active task with the right receipt evidence.",
        "safe_next_command": "make agent-task-status TASK_STATUS_STRICT=1",
        "automation_level": "human_review_required",
    },
    "missing_final_receipts": {
        "category": "task_evidence",
        "title": "Missing task receipts",
        "plain_reason": "Some terminal task records point to durable receipt files that do not exist.",
        "why_it_blocks": "Kit cannot prove those tasks ended safely, so it refuses to claim the repo is fully closed out.",
        "recommended_action": "Link durable receipts where evidence exists. If evidence is missing, mark the task blocked instead of pretending it is done.",
        "safe_next_command": "make agent-task-status TASK_STATUS_STRICT=1",
        "automation_level": "human_review_required",
    },
    "dirty_task_worktrees": {
        "category": "task_evidence",
        "title": "Dirty task worktrees",
        "plain_reason": "One or more task worktrees still have uncommitted changes.",
        "why_it_blocks": "Kit will not prune or finalize worktrees that may contain unsaved work.",
        "recommended_action": "Inspect each dirty task worktree and preserve, commit, or receipt the changes.",
        "safe_next_command": "make agent-task-status TASK_STATUS_STRICT=1",
        "automation_level": "human_review_required",
    },
    "blocked_task_state": {
        "category": "task_evidence",
        "title": "Stale or missing task state",
        "plain_reason": "Some task records point to missing worktrees, stale leases, or overlapping task state.",
        "why_it_blocks": "Kit cannot prove the task ledger matches the real repository state.",
        "recommended_action": "Reconcile the task records: link receipts, mark stale tasks blocked, or close out worktrees only when evidence supports it.",
        "safe_next_command": "make agent-task-status TASK_STATUS_STRICT=1",
        "automation_level": "human_review_required",
    },
    "parallel_context_blockers": {
        "category": "task_evidence",
        "title": "Parallel work blockers",
        "plain_reason": "Parallel coordination found task state that blocks starting or closing write-capable work.",
        "why_it_blocks": "Proceeding could overlap with another task scope or hide stale task metadata.",
        "recommended_action": "Run strict task status and resolve the reported coordination blockers before closeout.",
        "safe_next_command": "make agent-task-status TASK_STATUS_STRICT=1",
        "automation_level": "human_review_required",
    },
    "closeout_candidates": {
        "category": "sibling_worktrees",
        "title": "Finished worktrees need reviewed closeout",
        "plain_reason": "Some finished task worktrees are eligible for closeout but have not been removed yet.",
        "why_it_blocks": "Kit keeps finished worktrees until their branch, receipt, and cleanliness checks pass.",
        "recommended_action": "Review the closeout dry run, then apply task closeout for eligible worktrees.",
        "safe_next_command": "make agent-task-closeout TASK_CLOSEOUT_JSON=1",
        "automation_level": "agent_can_prepare",
    },
    "closeout_blocked": {
        "category": "sibling_worktrees",
        "title": "Blocked sibling worktrees",
        "plain_reason": "Closeout preview found sibling task worktrees that need inspection before cleanup.",
        "why_it_blocks": "Kit cannot safely remove or ignore worktrees until their blocked reasons are understood.",
        "recommended_action": "Inspect the blocked closeout entries and resolve their safety reasons one by one.",
        "safe_next_command": "make agent-task-closeout TASK_CLOSEOUT_JSON=1",
        "automation_level": "human_review_required",
    },
    "external_blockers": {
        "category": "tooling_or_policy",
        "title": "External ledger blockers",
        "plain_reason": "The workflow ledger reported automation, receipt, or repository blockers outside the standard closeout categories.",
        "why_it_blocks": "Kit treats unknown or external blockers conservatively so it does not claim completion with unresolved policy state.",
        "recommended_action": "Read the ledger blocker details and resolve or receipt the underlying condition.",
        "safe_next_command": "make agent-state-ledger STATE_LEDGER_JSON=1",
        "automation_level": "human_review_required",
    },
}


def explain_blocker(blocker: dict[str, Any]) -> dict[str, Any]:
    code = str(blocker.get("code") or "blocker")
    base = BLOCKER_EXPLANATIONS.get(
        code,
        {
            "category": "tooling_or_policy",
            "title": code.replace("_", " ").title(),
            "plain_reason": str(blocker.get("message") or "Kit reported a closeout blocker."),
            "why_it_blocks": "Kit cannot prove closeout is safe while this blocker is unresolved.",
            "recommended_action": "Inspect the blocker details and resolve or receipt the underlying condition.",
            "safe_next_command": "kit closeout-plan --json",
            "automation_level": "human_review_required",
        },
    )
    return {
        **blocker,
        **base,
        "code": code,
        "message": blocker.get("message") or base["plain_reason"],
        "count": int(blocker.get("count") or 0),
    }


def explain_blockers(blockers: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [explain_blocker(blocker) for blocker in blockers or []]


def closeout_plan_human_summary(payload: dict[str, Any]) -> dict[str, Any]:
    explanations = explain_blockers(payload.get("claim_blockers") or [])
    categories = {item.get("category") for item in explanations}
    next_action = payload.get("next_action") or {}
    can_claim_done = bool(payload.get("can_claim_done"))
    dirty = payload.get("dirty") or {}
    dirty_count = int(dirty.get("count") or 0)

    if can_claim_done:
        title = "Ready to claim done"
        plain_reason = "Kit found no dirty checkout, task evidence, managed-update, or closeout blockers."
        why_it_blocks = "Nothing is blocking closeout."
        recommended_action = "Record the successful closeout in your final handoff."
    elif dirty.get("dirty"):
        title = "Closeout blocked: source changes need integration"
        plain_reason = f"The primary checkout has source changes in {dirty_count} changed file{'s' if dirty_count != 1 else ''}."
        why_it_blocks = "Kit cannot tell whether those changes should be committed, handed off, or removed."
        recommended_action = "Inspect the dirty files and preserve real work in logical commits before claiming closeout."
    elif "task_evidence" in categories and categories <= {"task_evidence", "kit_update_review", "sibling_worktrees"}:
        title = "Closeout blocked: evidence cleanup needed"
        plain_reason = "The source tree may be clean, but Kit cannot prove older workflow tasks ended safely."
        why_it_blocks = "Historical task records, missing receipts, or blocked worktree state make the workflow ledger incomplete."
        recommended_action = "Review task evidence first, then link durable receipts, mark stale tasks blocked, or inspect sibling worktrees as appropriate."
    elif "kit_update_review" in categories:
        title = "Closeout blocked: kit update review needed"
        plain_reason = "There are managed-file proposals pending review."
        why_it_blocks = "Kit keeps managed updates separate from Git dirt, but they still need an accept, reject, or receipt decision."
        recommended_action = "Review the latest update report and record the decision for the managed proposals."
    elif "sibling_worktrees" in categories:
        title = "Closeout blocked: sibling worktrees need inspection"
        plain_reason = "Linked task worktrees still need prune or closeout review."
        why_it_blocks = "Kit cannot safely remove or ignore sibling worktrees until their branch and cleanliness state is understood."
        recommended_action = "Run the reported worktree or task-closeout dry run and resolve each blocked worktree."
    else:
        title = "Closeout blocked"
        plain_reason = "Kit reported one or more closeout blockers."
        why_it_blocks = "Kit cannot prove closeout is safe while blockers remain."
        recommended_action = "Review the blocker details and run the next safe command."

    return {
        "title": title,
        "status": "clean" if can_claim_done else "blocked",
        "plain_reason": plain_reason,
        "why_it_blocks": why_it_blocks,
        "recommended_action": recommended_action,
        "safe_next_command": next_action.get("command") or "kit closeout-plan --json",
        "next_action_reason": next_action.get("reason") or "",
        "remaining": [
            {
                "code": item.get("code"),
                "title": item.get("title"),
                "category": item.get("category"),
                "count": item.get("count", 0),
            }
            for item in explanations
        ],
    }


def closeout_fix_human_summary(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    final_closeout = payload.get("final_closeout") or {}
    if final_closeout:
        final_summary = final_closeout.get("human_summary") or closeout_plan_human_summary(final_closeout)
    else:
        final_summary = {}
    commits = payload.get("commits") or []
    receipts = payload.get("receipts") or []
    pruned = payload.get("worktrees_pruned") or []
    pushed = payload.get("branches_pushed") or []
    after = payload.get("after") or {}

    completed: list[str] = []
    if commits:
        completed.append(f"Created {len(commits)} commit{'s' if len(commits) != 1 else ''}.")
    if receipts:
        completed.append(f"Wrote {len(receipts)} durable receipt{'s' if len(receipts) != 1 else ''}.")
    if pruned:
        completed.append(f"Pruned {len(pruned)} disposable worktree{'s' if len(pruned) != 1 else ''}.")
    if pushed:
        successful_pushes = [item for item in pushed if item.get("exit_code") == 0]
        if successful_pushes:
            completed.append(f"Pushed {len(successful_pushes)} branch{'es' if len(successful_pushes) != 1 else ''}.")
    if after.get("status_entries") == []:
        completed.append("Primary worktree is clean.")

    if result == "applied":
        title = "Guided closeout applied"
        plain_reason = "Strict closeout passed after the guided workflow."
        why_it_blocks = "Nothing is blocking closeout."
        recommended_action = "Review the receipt and pushed branch details."
        status = "applied"
    elif result == "blocked":
        title = "Guided closeout blocked after partial progress"
        plain_reason = final_summary.get("plain_reason") or "The command ran, but strict closeout still has blockers."
        why_it_blocks = final_summary.get("why_it_blocks") or "Kit cannot prove closeout is safe while blockers remain."
        recommended_action = final_summary.get("recommended_action") or "Review the remaining blockers and run the next safe command."
        status = "blocked"
    else:
        title = "Guided closeout preview"
        plain_reason = "No write-capable closeout has run yet."
        why_it_blocks = "Preview mode reports what would be attempted without changing the target repo."
        recommended_action = "Run apply mode only after reviewing the preview and confirming the target repo."
        status = str(result or "preview")

    blocker_explanations = final_closeout.get("blocker_explanations") or []
    if not blocker_explanations:
        blocker_explanations = [
            explain_blocker({"code": "closeout_blocked", "message": blocker, "count": 1})
            for blocker in payload.get("blockers") or []
        ]

    return {
        "title": title,
        "status": status,
        "plain_reason": plain_reason,
        "why_it_blocks": why_it_blocks,
        "recommended_action": recommended_action,
        "safe_next_command": final_summary.get("safe_next_command") or "kit closeout-plan --json",
        "completed": completed,
        "remaining": [
            {
                "code": item.get("code"),
                "title": item.get("title"),
                "category": item.get("category"),
                "count": item.get("count", 0),
            }
            for item in blocker_explanations
        ],
    }
