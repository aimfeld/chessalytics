"""Source-level invariant test for the D-04 reversal (Phase 207, RESET-05).

Eligibility for password reset means "has a password to reset" (credential
state), never "is this a Google/SSO account" (account type). 125 of the 172
eligible prod accounts hold BOTH a password and a linked Google account, so
an account-type reading strands 73% of them.

Two independent assertions, so a failure names which invariant broke:

1. Single-site: the empty-hash comparison (a comparison against an empty
   string literal, or a truthiness branch on the attribute) occurs exactly
   once across app/, and that occurrence is in app/users.py. Scoped to
   production sources — tests/ writes empty hashes as fixture data, and
   guest_service.py's occurrences are keyword-argument assignments
   (hashed_password=""), which this detector does not flag (it targets
   comparison/branch forms only, not assignments).
2. No account-type derivation: within the body of
   UserManager.on_after_forgot_password, no reference to `oauth_account`,
   `oauth_accounts`, or `is_guest` appears. Extracted via
   inspect.getsource() rather than regex-slicing the file, so the bound
   stays correct as the file changes around it.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent / "app"

_HASHED_PASSWORD_ATTR = "hashed_password"


def _is_hashed_password_attr(node: ast.AST) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == _HASHED_PASSWORD_ATTR


def _is_empty_string_constant(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value == ""


class _HashedPasswordPredicateVisitor(ast.NodeVisitor):
    """Finds every comparison-against-'' or truthiness-branch use of
    `<expr>.hashed_password`. Does NOT match keyword-argument assignments
    (e.g. `hashed_password=""` in a constructor call) — those are
    ast.keyword nodes, a different AST shape entirely.
    """

    def __init__(self) -> None:
        self.sites: list[int] = []

    def visit_Compare(self, node: ast.Compare) -> None:
        operands = [node.left, *node.comparators]
        has_attr = any(_is_hashed_password_attr(o) for o in operands)
        has_empty_str = any(_is_empty_string_constant(o) for o in operands)
        if has_attr and has_empty_str:
            self.sites.append(node.lineno)
        self.generic_visit(node)

    def visit_UnaryOp(self, node: ast.UnaryOp) -> None:
        if isinstance(node.op, ast.Not) and _is_hashed_password_attr(node.operand):
            self.sites.append(node.lineno)
        self.generic_visit(node)

    def visit_If(self, node: ast.If) -> None:
        # Direct truthiness branch: `if user.hashed_password:` (no `not`,
        # no comparison — the bare attribute as the test expression).
        if _is_hashed_password_attr(node.test):
            self.sites.append(node.lineno)
        self.generic_visit(node)


def _find_hashed_password_predicate_sites() -> list[tuple[str, int]]:
    """Scan every .py file under app/ for hashed_password comparison/branch sites."""
    sites: list[tuple[str, int]] = []
    for path in sorted(APP_ROOT.rglob("*.py")):
        source = path.read_text()
        tree = ast.parse(source, filename=str(path))
        visitor = _HashedPasswordPredicateVisitor()
        visitor.visit(tree)
        for lineno in visitor.sites:
            sites.append((str(path.relative_to(APP_ROOT.parent)), lineno))
    return sites


def test_hashed_password_predicate_is_single_site_in_users_py() -> None:
    """Invariant 1: exactly one hashed_password comparison/branch site exists
    under app/, and it lives in app/users.py."""
    sites = _find_hashed_password_predicate_sites()
    assert len(sites) == 1, (
        "Expected exactly ONE hashed_password credential-state check under app/ "
        f"(the eligibility gate in on_after_forgot_password), found {len(sites)}: {sites}. "
        "Eligibility means 'has a password to reset' — a second site risks "
        "re-fusing the account-type reading onto the empty hash."
    )
    path, lineno = sites[0]
    assert path == "app/users.py", (
        f"The single hashed_password predicate site must live in app/users.py "
        f"(the on_after_forgot_password eligibility gate), found it in {path}:{lineno} instead."
    )


_FORBIDDEN_IDENTIFIERS = frozenset({"oauth_account", "oauth_accounts", "is_guest"})


class _ForbiddenIdentifierVisitor(ast.NodeVisitor):
    """Finds real CODE references (Name/Attribute nodes) to forbidden
    identifiers. Deliberately does NOT scan string literals — the function's
    own docstring and inline comments explain, in prose, why oauth_account/
    is_guest must never be read here, which would false-positive a naive
    substring search over the raw source text (comments aren't part of the
    AST at all; the docstring is an ast.Constant, also excluded).
    """

    def __init__(self) -> None:
        self.found: list[tuple[str, int]] = []

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in _FORBIDDEN_IDENTIFIERS:
            self.found.append((node.id, node.lineno))
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in _FORBIDDEN_IDENTIFIERS:
            self.found.append((node.attr, node.lineno))
        self.generic_visit(node)


def test_on_after_forgot_password_does_not_derive_account_type() -> None:
    """Invariant 2: on_after_forgot_password never reads oauth_account,
    oauth_accounts, or is_guest — deriving eligibility from account type
    would strand 125 of the 172 eligible prod accounts (73%), every one of
    them holding a real password hash alongside a linked Google account."""
    from app.users import UserManager

    source_lines, start_lineno = inspect.getsourcelines(UserManager.on_after_forgot_password)
    tree = ast.parse(textwrap.dedent("".join(source_lines)))
    visitor = _ForbiddenIdentifierVisitor()
    visitor.visit(tree)
    # node.lineno is 1-based within the dedented snippet; translate back to the
    # real file:line so the failure names an actionable location, not just a name.
    named_sites = [
        f"app/users.py:{start_lineno + lineno - 1} ({identifier})"
        for identifier, lineno in visitor.found
    ]
    assert not visitor.found, (
        f"on_after_forgot_password references forbidden identifiers at {named_sites} — "
        "eligibility must be derived solely from the presence of a stored password "
        "(credential state), never from account type. 125 of 172 eligible prod accounts "
        "hold BOTH a password and a linked Google account; an account-type reading "
        "strands 73% of them."
    )
