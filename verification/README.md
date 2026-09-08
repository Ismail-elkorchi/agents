# Application verification

Shared check contracts for Coding and Writing. Applications choose required checks and acceptance policy. External effects execute through Agent Core’s admitted effect executor; verification is not a Core run phase.

Checks receive an `executionId` and an `AbortSignal`. Applications bind any domain inputs when constructing checks. The execution ID is stable across recovery within its `ownerId`; a new verification execution needs a new ID, even for unchanged material. Coding and Writing bind post-execution verification to the committed terminal snapshot. Verification does not require an assistant response or inference history.
