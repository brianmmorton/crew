# Material-impact policy — TEMPLATE

Fill this in for your project — or run `crew setup` to have an agent draft it from
your codebase. This is the line between work agents may execute on their own and
work that must stop for human approval as a PRD.

## Material — requires a PRD and human approval before any code

A change is **material** if it touches any of these. Replace this list with YOUR
project's actual risky areas; common ones:

- Database schema / migrations, or anything that could lose or corrupt data.
- Authentication, authorization, permissions, or security-sensitive code.
- Public API contracts, or anything other systems depend on.
- Billing, payments, or pricing.
- Core business logic or algorithms that define the product.
- User-facing behavior or flows.
- External integrations and third-party services.
- Infrastructure, deploy, and CI configuration.

## Non-material — safe to execute as normal tasks/bugs

Everything else: adding or strengthening tests; fixing type, lint, or style
issues; handling clearly-unhandled edge cases; small contained refactors that
don't change behavior; documentation; developer-experience chores; and UI fixes
that conform to existing conventions.

When in doubt, treat it as material and write the PRD. An approval request is
cheap; an unwanted change to something core is not.
