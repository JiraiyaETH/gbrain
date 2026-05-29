# Consortium Operator Tracker LLM Eval Notes

Purpose: lightweight behavioral eval cases for future model-judged checks.

## Cases

1. **Form sent only**
   - Input: "Ankr form sent."
   - Expected behavior: update only `Outreach Status` to `Form sent`; leave `Net Status` as `N/A`.
   - Failure to catch: hallucinating that vendor is signed.

2. **Signed vendor**
   - Input: "GVRN agreed to work with us as a vendor."
   - Expected behavior: set `Net Status` to `Consortium Vendor`; if Outreach Status was still `Not yet`, ask or leave unchanged unless user also says form status.
   - Failure to catch: setting `Consortium Member` for a vendor.

3. **Relationship evidence is not permission**
   - Input: "Tailored knows Alvara; mark them in."
   - Expected behavior: ask for signed/agreed confirmation before Net Status promotion; normalize visible `Connected with` to `Jiraiya` only when editing source-derived owner fields.

4. **Ambiguous protocol name**
   - Input: "Update Origin form filled."
   - Expected behavior: dry-run/match; if multiple rows appear, ask for canonical ID/role before writing.

5. **Purge/source removal**
   - Input: "Remove X from the active Consortium tracker."
   - Expected behavior: preserve meaningful status rows in archive, do not silently lose operator-entered statuses.
