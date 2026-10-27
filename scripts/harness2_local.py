"""Local harness2 adapter: Propose-Probe-Compose over real recurring tasks.

Uses the patched harness2 package (see scripts/harness2-opencode-go.patch) with
the installed `opencode` binary and the current session model — no Google
services, no LAB/JB/WB downloads. Tasks live in harness2-tasks/<domain>/<id>/
(PROMPT.md + inputs/ + CHECKS.json); scoring is deterministic file/content
checks, so judging needs no model. The experience library lands in
harness2-work/library/, run artifacts in harness2-work/runs/.

Usage:
  python3 scripts/harness2_local.py --dry-run
  python3 scripts/harness2_local.py --k 1 --modes agg
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HARNESS2_PKG = os.environ.get("HARNESS2_PKG", "/tmp/opencode/harness2")
sys.path.insert(0, HARNESS2_PKG)

from harness2 import config  # noqa: E402
from harness2.core import schedule  # noqa: E402
from harness2.core import tree as harness_tree  # noqa: E402
from harness2.core.proposer import Proposer  # noqa: E402
from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec  # noqa: E402
from harness2.substrate.opencode import OpencodeSubstrate  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
TASKS = REPO / "harness2-tasks"
WORK = Path(os.environ.get("HARNESS2_WORK", REPO / "harness2-work"))
OC_HOME = Path.home() / ".config" / "opencode"

FULL_SKILLS = ("secure-credentials", "karpathy-guidelines", "gmail-app-password")
TOOL_GUIDANCE = """# Tool guidance
Prefer the smallest tool that answers the question: read before grep, grep
before shell. Keep bash one-liners read-only unless the task asks for writes.
Never print secrets; credentials flow via env vars only.
"""


def _frontmatter_desc(body: str) -> str:
    m = re.search(r"^description:\s*(.+)$", body[:600], re.M)
    return m.group(1).strip() if m else "(no description)"


def build_base_tree() -> harness_tree.Tree:
    """Export the live opencode setup as a c1..c8 tree within the always-on cap."""
    surface = OpencodeSubstrate().surface()
    tree: harness_tree.Tree = {}
    tree["systemprompt.md"] = "\n\n---\n\n".join(
        (OC_HOME / "instructions" / f).read_text(encoding="utf-8").strip()
        for f in ("standing-ops.md", "secure-credentials.md")
    )
    try:
        perms = json.loads((OC_HOME / "opencode.json").read_text(encoding="utf-8"))["permission"]
        deny = sorted(r for scope in perms.values() for r, v in scope.items() if v == "deny")
    except (OSError, ValueError, KeyError, AttributeError):
        deny = []
    tree["guardrails.md"] = (
        "# Guardrails\nDeny these reads without asking: "
        + (", ".join(deny) if deny else "(none configured)")
        + "\nDeny all secret-file reads (see secure-credentials skill).\n"
    )
    tree["tool_descriptions/tool_guidance.md"] = TOOL_GUIDANCE
    for name in FULL_SKILLS:
        src = OC_HOME / "skills" / name / "SKILL.md"
        if src.is_file():
            tree[f"skills/{name}/SKILL.md"] = src.read_text(encoding="utf-8")
        for helper in sorted((OC_HOME / "skills" / name / "scripts").glob("*.py")):
            tree[f"skills/{name}/scripts/{helper.name}"] = helper.read_text(encoding="utf-8")
    # secure-credentials/SKILL.md addresses gmail_app.py as root-relative
    # `scripts/gmail_app.py`; ship the same real bytes at root (not a stub).
    helper = OC_HOME / "skills" / "gmail-app-password" / "scripts" / "gmail_app.py"
    if helper.is_file():
        tree["scripts/gmail_app.py"] = helper.read_text(encoding="utf-8")
    agent = OC_HOME / "agents" / "docs-manager.md"
    if agent.is_file():
        tree["sub_agents/docs_manager/AGENT.md"] = agent.read_text(encoding="utf-8")
    used = sum(len(v) for k, v in tree.items() if k in surface.always_on)
    budget = surface.always_on_max - used - 1024
    mem_parts = [(MEMORY_INDEX := (REPO / "memory" / "MEMORY.md").read_text(encoding="utf-8"))]
    for topic in sorted((REPO / "memory").glob("*.md")):
        if topic.name == "MEMORY.md":
            continue
        mem_parts.append(f"\n\n--- {topic.name} ---\n" + topic.read_text(encoding="utf-8"))
        if sum(len(p) for p in mem_parts) >= budget:
            break
    digest = "".join(mem_parts)[:budget]
    tree["LongTermMEMORY.md"] = digest
    harness_tree.autotrigger(surface, tree)
    harness_tree.validate(surface, tree, allow_subagents=True, reserved_scripts=frozenset())
    return tree


def compose_agents_md(tree: harness_tree.Tree) -> str:
    """Workspace AGENTS.md: always-on text plus skill/subagent indexes."""
    surface = OpencodeSubstrate().surface()
    parts = [
        t
        for f in surface.always_on
        if (t := tree.get(f, "").strip())
    ]
    idx = "\n".join(
        f"- `{d.name}`: {_frontmatter_desc((d / 'SKILL.md').read_text(errors='replace'))}"
        for d in sorted((OC_HOME / "skills").iterdir())
        if (d / "SKILL.md").is_file()
    )
    if idx:
        parts.append("# AVAILABLE SKILLS\nLoad with the `skill` tool when the situation matches:\n" + idx)
    parts.append(
        "# AVAILABLE SUBAGENTS\nDelegate with the `task` tool when the situation matches:\n"
        "- `docs_manager`: Writes and updates project documentation from structured scout reports"
    )
    return "\n\n---\n\n".join(parts)


PROMPT_TMPL = """=== TASK ===
{task}

=== WORKSPACE ===
{workspace}

=== INSTRUCTIONS ===
1. Read AGENTS.md first, then the files in task/ above.
2. Complete the task as specified. Load a skill from skills/ only when its
   described situation matches (see AGENTS.md index).
3. Only save the final deliverables to the output directory below. Do not save
   any intermediate or temporary files, and do not print secrets.
4. If data looks ambiguous, state the assumption in the deliverable and continue.

=== OUTPUT DIRECTORY ===
{output}
"""


class LocalAdapter:
    def __init__(self, root: Path, model: str):
        self.root = root
        self.substrate = OpencodeSubstrate()
        self._model = model
        ch = ChannelSpec("opencode", model, effort="high", timeout=3600)
        self.spec = BenchSpec(
            name="local",
            runs_root=root / "runs",
            install_mode="workspace_config",
            prompts=BenchPrompts(work="produce the requested office deliverable"),
            channels={"proposer": ch, "selector": ch},
            allow_subagents=True,
            obs_trunc=20_000,
        )
        self._tasks: dict[str, Path] = {}
        for domain_dir in sorted(TASKS.iterdir()):
            if domain_dir.is_dir():
                for task_dir in sorted(domain_dir.iterdir()):
                    if (task_dir / "PROMPT.md").is_file():
                        self._tasks[f"{domain_dir.name}/{task_dir.name}"] = task_dir
        if not self._tasks:
            raise RuntimeError(f"no tasks found under {TASKS}")
        self._base_dir = root / "base"
        harness_tree.write_tree(self.substrate.surface(), build_base_tree(), self._base_dir)

    # -- BenchSpec surface --
    def tasks(self, split: str = "all") -> list[str]:
        return sorted(self._tasks)

    def domain_of(self, task_id: str) -> str:
        return task_id.split("/")[0]

    def task_prompt(self, task_id: str) -> str:
        return (self._tasks[task_id] / "PROMPT.md").read_text(encoding="utf-8")

    def task_files(self, task_id: str) -> Path | None:
        d = self._tasks[task_id] / "inputs"
        return d if d.is_dir() else None

    def prompts_for(self, task_id: str) -> BenchPrompts:
        dom = self.domain_of(task_id)
        work = {
            "nightly-brief": "write a fund-manager nightly brief from position files",
            "trading-review": "reconcile a trade ledger into net positions and cash flow",
        }.get(dom, "produce the requested office deliverable")
        return BenchPrompts(
            work=work,
            domain_word="practice area",
            inv_levers="Always-on wording, guardrails, tool guidance, skill triggers.",
            dom_levers=f"Domain know-how for {dom}: section order, totals to show, terms to use.",
            yardstick="The deliverable exists in output/ with the required sections and figures.",
        )

    def base_harness(self) -> Path:
        return self._base_dir

    def validate_tree(self, harness: harness_tree.Tree) -> None:
        surface = self.substrate.surface()
        missing = [f for f in surface.always_on if not harness.get(f, "").strip()]
        if missing:
            raise ValueError(f"always-on files must stay non-empty: {missing}")

    def preflight(self) -> None:
        if not shutil.which("opencode"):
            raise RuntimeError("no `opencode` on PATH")
        if "/" not in self._model:
            raise RuntimeError(f"model {self._model!r} is not provider/model")

    # -- rollout --
    def execute(
        self, task_id: str, harness_dir: Path | None, run_id: str, *, timeout: int | None = None
    ) -> Path:
        run_dir = self.spec.runs_root / "executions" / run_id.replace("/", "__")
        run_dir.mkdir(parents=True, exist_ok=True)
        ws = Path(tempfile.mkdtemp(prefix="h2local-"))
        try:
            src = harness_dir or self._base_dir
            tree = harness_tree.read_tree(self.substrate.surface(), src)
            for rel, body in tree.items():
                p = ws / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(body, encoding="utf-8")
            (ws / "AGENTS.md").write_text(compose_agents_md(tree), encoding="utf-8")
            (ws / "opencode.json").write_text('{"agent":{"build":{"steps":120}}}\n', encoding="utf-8")
            inputs = self.task_files(task_id)
            if inputs:
                shutil.copytree(inputs, ws / "task")
            out = ws / "output"
            out.mkdir(exist_ok=True)
            prompt = PROMPT_TMPL.format(task=self.task_prompt(task_id), workspace=ws, output=out)
            cmd = [
                shutil.which("opencode") or "opencode", "run", "--standalone", prompt,
                "--model", self._model, "--title", f"h2local-{task_id.split('/')[-1]}",
                "--format", "json",
            ]
            env = dict(os.environ)
            env["PWD"] = str(ws)  # opencode v2 resolves its workspace from $PWD, not getcwd()
            env["OPENCODE_PERMISSION"] = json.dumps(
                {"external_directory": {"*": "deny", str(ws): "allow", f"{ws}/**": "allow"}}
            )
            with open(run_dir / "stdout.jsonl", "w", encoding="utf-8") as fh:
                proc = subprocess.run(cmd, cwd=ws, env=env, stdout=fh,
                                      stderr=subprocess.DEVNULL, timeout=timeout or 1200)
            traj = self.substrate.read_trajectory(
                run_dir / "stdout.jsonl", obs_trunc=self.spec.obs_trunc, max_chars=60_000)
            (run_dir / "trajectory.md").write_text(traj, encoding="utf-8")
            (run_dir / "rc").write_text(str(proc.returncode), encoding="utf-8")
            if any(out.iterdir()):
                shutil.copytree(out, run_dir / "output", dirs_exist_ok=True)
        finally:
            shutil.rmtree(ws, ignore_errors=True)
        return run_dir

    def delivered(self, run_dir: Path) -> bool:
        d = Path(run_dir) / "output"
        return d.is_dir() and any(d.iterdir())

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        t = Path(run_dir) / "trajectory.md"
        if not t.is_file():
            return "(no trajectory recorded)"
        return t.read_text(encoding="utf-8", errors="replace")[:obs_trunc]

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        d = Path(run_dir) / "output"
        if not d.is_dir():
            return {}
        return {p.name: p.read_text(encoding="utf-8", errors="replace")[:20_000]
                for p in sorted(d.iterdir()) if p.is_file()}

    def deliverable_text(self, run_dir: Path) -> str:
        return "\n\n".join(
            f"--- {n} ---\n{t}" for n, t in self.deliverable_files(run_dir).items())

    def score(self, run_dir: Path, task_id: str) -> dict | None:
        try:
            checks = json.loads((self._tasks[task_id] / "CHECKS.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        files = self.deliverable_files(run_dir)
        passed, total, details = 0, 0, []
        for name in checks.get("files", []):
            total += 1
            ok = name in files and files[name].strip() != ""
            passed += ok
            details.append(f"file {name}: {'ok' if ok else 'MISSING'}")
        for name, needles in checks.get("contains", {}).items():
            for n in needles:
                total += 1
                ok = n in files.get(name, "")
                passed += ok
                details.append(f"{name} contains {n!r}: {'ok' if ok else 'MISSING'}")
        return {"n_passed": passed, "n_criteria": total,
                "all_pass": total > 0 and passed == total, "details": details}


def cmd_promote(args) -> int:
    """Copy a run's chosen harness tree to harness2-work/promoted/<domain>/."""
    import glob as _glob

    ns_dirs = sorted(_glob.glob(str(WORK / "runs" / "local-oc-*")))
    if not ns_dirs:
        print("no runs yet", file=sys.stderr)
        return 1
    ns = Path(ns_dirs[-1])
    task_dirs = sorted(ns.glob(f"{args.promote}__*"))
    if args.task:
        task_dirs = [d for d in task_dirs if d.name == f"{args.promote}__{args.task.replace('/', '__')}"]
    if not task_dirs:
        print(f"no task dirs for domain {args.promote} in {ns}", file=sys.stderr)
        return 1
    if len(task_dirs) > 1 and not args.task:
        print(f"domain has several tasks, pass --task: {[d.name for d in task_dirs]}",
              file=sys.stderr)
        return 1
    import harness2.config as _c
    model = _c.SOLVER_MODEL_OC
    adapter = LocalAdapter(WORK, model)
    for td in task_dirs:
        summary = json.loads((td / "summary.json").read_text(encoding="utf-8"))
        task_id = summary["task_id"]
        sel = (summary.get("selections") or {}).get(args.mode)
        if not sel or not sel.get("ok") or not sel.get("chosen_label"):
            print(f"{task_id}: no successful {args.mode} selection", file=sys.stderr)
            return 1
        label = sel["chosen_label"]
        src = td / "harnesses" / label
        dest = WORK / "promoted" / args.promote
        import shutil as _shutil
        _shutil.rmtree(dest, ignore_errors=True)
        (dest / "tree").mkdir(parents=True)
        _shutil.copytree(src, dest / "tree", dirs_exist_ok=True)
        _shutil.copytree(adapter.base_harness(), dest / "base", dirs_exist_ok=True)
        score = adapter.score(Path(sel["chosen_run_dir"]), task_id)
        meta = {"domain": args.promote, "task": task_id, "mode": args.mode,
                "source_ns": ns.name, "label": label,
                "fingerprint": sel.get("harness_fingerprint", ""),
                "chosen_tree_is_base": sel.get("chosen_tree_is_base", True),
                "score": score,
                "model": model, "time": __import__("time").time()}
        (dest / "PROMOTED.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        print(f"promoted {args.promote}: {label} fp={meta['fingerprint'][:12]} "
              f"score={score['n_passed']}/{score['n_criteria']} base={meta['chosen_tree_is_base']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--k", type=int, default=1)
    p.add_argument("--modes", default="agg", help="subset of agg,seq")
    p.add_argument("--domain", default="", help="run one domain only")
    p.add_argument("--max-tasks", type=int, default=None)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--promote", default="", help="promote a domain's chosen tree, then exit")
    p.add_argument("--task", default="", help="task id within the domain (for --promote)")
    p.add_argument("--mode", default="agg", help="selection mode to promote (for --promote)")
    args = p.parse_args(argv)
    if args.promote:
        return cmd_promote(args)
    model = config.SOLVER_MODEL_OC
    if "/" not in model:
        print("error: no model: set HARNESS2_SOLVER_MODEL or opencode.json model", file=sys.stderr)
        return 1
    adapter = LocalAdapter(WORK, model)
    by_domain: dict[str, list[str]] = {}
    for tid in adapter.tasks():
        by_domain.setdefault(adapter.domain_of(tid), []).append(tid)
    if args.domain:
        by_domain = {args.domain: by_domain[args.domain]}
    if args.max_tasks is not None:
        by_domain = {d: ts[: args.max_tasks] for d, ts in by_domain.items()}
    modes = tuple(m.strip() for m in args.modes.split(",") if m.strip())
    print(f"model: {model} k={args.k} modes={modes}")
    for d, ts in by_domain.items():
        print(f"domain {d}: {ts}")
    if args.dry_run:
        print(f"library: {WORK / 'library'} runs: {WORK / 'runs'}")
        return 0
    adapter.preflight()
    prop = Proposer(adapter.spec.channels["proposer"], audit_dir=WORK / "runs" / "_audit")
    failed = 0
    for d, ts in by_domain.items():
        rep = schedule.run_domain(d, ts, args.k, adapter=adapter, prop=prop,
                                  runs_root=WORK / "runs",
                                  library_root=WORK / "library", modes=list(modes))
        print(f"domain {d}: done={rep['done']} failed={rep['failed']}")
        failed += rep["failed"]
        for t in rep["tasks"]:
            print(f"  {t.get('task', t)}: {t['status']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
