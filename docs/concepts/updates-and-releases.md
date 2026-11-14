```mermaid
flowchart LR
    Main[Changes merge to main] --> Soak[Owner hub runs commit for 24 hours]
    Soak --> Gate{Doctor good and no crash-loop alert?}
    Gate -->|No| Wait[No release]
    Gate -->|Yes| Tag[Version commit and tag]
    Tag --> Stable[Move stable tag]
    Stable --> Notes[Publish GitHub release notes]
    Stable --> Fetch[Installed hubs check every six hours]
    Fetch --> Safe{Clean main checkout and fast-forward only?}
    Safe -->|Yes| Quiet[Wait for quiet sessions]
    Quiet --> Restart[Restart into new code]
    Safe -->|No| Skip[Leave checkout unchanged]
```

# Updates and releases

A merge to `main` does not update installed hubs. Installations follow the separate `stable` tag.

The repository admin's hub can release a commit after a 24-hour soak. The same commit must run on that hub.

The gate also requires a healthy doctor result and no recent crash-loop alert. A failed gate creates no release.

A release bumps the version files and creates a version tag. It then moves `stable` and publishes the notes.

Installed hubs check `stable` every six hours. Only a clean checkout on `main` can move forward.

Updates use a fast-forward merge. A checkout with local commits or changes stays untouched.

After pulling, the hub waits until every session is quiet. It then restarts and tells the owner what changed.

Release tags are not signed yet. Issue #58 tracks that remaining trust gap.

See [AGENTS.md](../../AGENTS.md) for the supported update commands.
