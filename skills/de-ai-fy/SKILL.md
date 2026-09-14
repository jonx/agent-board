---
name: de-ai-fy
description: Clean up formulaic prose or unnecessary generated-code scaffolding when asked to make an artifact clearer and more idiomatic.
---
For prose, preserve the intended audience, facts, qualifications and author's voice. Replace vague claims with supported concrete statements; remove filler and repetitive transitions. Do not invent experiences or sources, or promise detector evasion.

For code, compare the changed area with nearby conventions and actual callers. Remove redundant commentary, unused abstractions and speculative fallbacks only when their lack of purpose is demonstrated. Preserve behavior, required error handling and meaningful tests; avoid judging code solely by whether it looks generated. Verify the affected behavior with the project's relevant checks.

Return the edited artifact and explain changes that materially affect meaning or behavior. For delegated work, include the artifact reference and verification in the task result.
