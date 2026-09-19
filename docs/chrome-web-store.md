# Chrome Web Store — Privacy practices (copy-paste answers)

Paste each line into **Privacy practices** on the item edit page.

## Single purpose

Pilot lets a locally running AI agent operate the browser tab you choose, and records
your own actions into reusable skills that can be replayed later.

## Permission justifications

**activeTab**
Shows which tab the agent is working on and lets a user-initiated action start driving
the current tab.

**tabs**
Reads the URL/title of the tab the user points the agent at, and lists the tabs in the
"Pilot" group so multi-tab workflows can be targeted.

**tabGroups**
Groups the tab Pilot drives into a "Pilot" tab group so the user can see which tab the
agent controls and add more tabs to the workspace.

**sidePanel**
Hosts the chat UI where the user talks to the agent and sees the recorded steps.

**scripting**
Injects the extension's own packaged content script into the page to record actions and
to act on elements (DOM mode), and to draw the on-page overlay.

**storage**
Stores the user's settings (chosen agent, model, page mode) and any API key they enter,
locally in the browser.

**offscreen**
Runs a hidden offscreen document that holds the local WebSocket connection to the
on-machine bridge, so the connection survives while the service worker is idle.

**alarms**
Periodic keep-alive that recreates the offscreen document if the browser tears it down.

**debugger**
Attaches the Chrome DevTools Protocol to read the page's accessibility tree and to send
native click/type input — the same mechanism Claude in Chrome uses. Optional: the user
can switch to DOM mode in Settings, which uses the content script instead.

**Host permission (`<all_urls>`)**
Required so the agent can operate on whatever web page the user asks it to. No data is
sent anywhere except to the user's own chosen local agent / model provider.

**Remote code use**
This extension does **not** load or execute any remote code. All JavaScript is packaged
with the extension; the CDP expressions used for page control are built from local code.
The AI agent that uses those tools is a separate program the user installs and runs on
their own machine.

## Data usage / certification

- Does the item collect or use personal/sensitive user data? **No.**
- Data sold to third parties? **No.**
- Data used for purposes unrelated to the single purpose? **No.**
- Data used for creditworthiness / lending? **No.**
- Certify data usage complies with the Developer Program Policies: **Yes.**

> If asked, page content and prompts are processed **locally**, and are sent only to the
> AI agent/model provider the user themselves configured — not to the developer.
