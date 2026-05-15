---
name: feedback-autonomous
description: User prefers autonomous operation — don't pause for confirmation, just implement and move forward
metadata:
  type: feedback
---

User explicitly asked to operate autonomously: "do all this autonomously please".

**Why:** User doesn't want to babysit decisions and confirmations during development sessions. They want changes made and working without constant check-ins.

**How to apply:** When implementing features, make reasonable decisions independently. Only pause for user input when there's a genuine architectural fork that can't be resolved without knowing their intent (e.g., two very different database schema designs). Don't ask "should I proceed?" or "does this look right?" — just do it and report what was done.
