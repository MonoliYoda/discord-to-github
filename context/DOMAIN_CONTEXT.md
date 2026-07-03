# Domain context — TEMPLATE

> **This is a template. Do not edit it in place.** Copy it to `context/CONTEXT.md` and fill that
> in with your own project's details:
>
> ```
> cp context/DOMAIN_CONTEXT.md context/CONTEXT.md
> ```
>
> `context/CONTEXT.md` is gitignored (it's your local, project-specific context) and is the default
> the tool loads. To use a different file, point `CONTEXT_FILE` in your `.env` at it.
>
> The content below is injected verbatim at the top of the extraction system prompt — it is how you
> teach the tool about *your* project: what it is, the vocabulary your community uses, and the exact
> set of labels issues may carry. The richer and more specific it is, the better the extracted
> issues read. Replace every section with your own domain.

## Product summary

One or two sentences describing what the product is and who uses it. Keep it concrete — this
frames every request the model reads.

_Example: "Acme Maps is a collaborative route-planning web app for delivery fleets. Dispatchers
build and share multi-stop routes; drivers follow them on a mobile overlay."_

## Glossary

List the domain terms that show up in discussions and would otherwise be opaque to a developer
reading the issue cold. Define each in one line. Expand as your community's vocabulary grows.

- **Term**: what it means in this product.
- **Another term**: its meaning.

## Label taxonomy

Issues must use **only** the labels below — the extraction step is instructed not to invent new
ones. Edit this list to match how your repository actually labels issues.

- type: `feature`, `bug`, `enhancement`, `question`
- area: `ui`, `api`, `auth`, `performance`, `docs`
