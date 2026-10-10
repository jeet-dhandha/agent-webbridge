// Playground and CLI walkthrough for /playground/. These are SIMULATIONS: no request is sent anywhere.
const cliData = {
    mcp: {
      desc: 'Run the zero-dependency stdio Model Context Protocol (MCP) server. Exposes browser navigation, snapshots, evaluate, and inputs to Claude Code, Cursor, and Windsurf.',
      cmd: 'npx agent-webbridge mcp',
      out: `[agent-webbridge] MCP stdio server ready (15 tools registered).
[agent-webbridge] Connecting to router at 127.0.0.1:10086...
✓ Connected to fleet router.
Tools: browser_navigate, browser_snapshot, browser_click, browser_fill, browser_evaluate, browser_screenshot...
Ready for agent commands.`
    },
    install: {
      desc: 'Download and install the CLI globally, or add it to Claude Code as an autonomous developer agent plugin.',
      cmd: 'npm i -g agent-webbridge',
      out: `added 1 package, and audited 2 packages in 1s

found 0 vulnerabilities

$ awb --version
1.3.1`
    },
    profiles: {
      desc: 'Resolve and display all Chrome user profiles detected on this machine. Shows deterministic ports, extension directory installation state, and active daemon statuses.',
      cmd: 'awb profiles',
      out: `Resolving local Google Chrome profiles...
Found 3 profiles:

- Profile: "Work"
  Directory: /Users/jeetdhandha/Library/Application Support/Google/Chrome/Profile 1
  Hashed Port: 13222
  Extension Installed: Yes (kgnhhbkooeplfdkfnicgekdmegckcnpl)
  Daemon Status: UP (pid: 58821)

- Profile: "Personal"
  Directory: /Users/jeetdhandha/Library/Application Support/Google/Chrome/Default
  Hashed Port: 13336
  Extension Installed: Yes (kgnhhbkooeplfdkfnicgekdmegckcnpl)
  Daemon Status: UP (pid: 58824)

- Profile: "Developer"
  Directory: /Users/jeetdhandha/Library/Application Support/Google/Chrome/Profile 2
  Hashed Port: 14820
  Extension Installed: Yes (kgnhhbkooeplfdkfnicgekdmegckcnpl)
  Daemon Status: UP (pid: 58826)`
    },
    connect: {
      desc: 'Connect profiles to their deterministic ports without manual clicks. Quits Chrome (saving sessions) and writes the hashed port URL directly to the extension\'s local LevelDB storage.',
      cmd: 'awb connect "Work" "Personal" "Developer"',
      out: `Quitting Google Chrome (saving sessions for restore)...
Chrome closed successfully.

Writing extension config for profile "Work" (port 13222)...
Writing extension config for profile "Personal" (port 13336)...
Writing extension config for profile "Developer" (port 14820)...

Write complete. Extensions pointed at local daemons.
Restore the default setting later using: \`awb connect "Work" --restore\``
    },
    up: {
      desc: 'Launches the agent-webbridge daemons for selected profiles, spins up the central router on port 10086, opens Chrome tabs to wake MV3 background service workers, and awaits connection confirmation.',
      cmd: 'awb up "Work" "Personal" "Developer"',
      out: `Starting daemon for "Work" on port 13222...
Starting daemon for "Personal" on port 13336...
Starting daemon for "Developer" on port 14820...
Starting HTTP proxy router on port 10086...

Waking browser profiles (opening headful popup)...
Waiting for extension connections (max 10s)...
✓ Work connected to daemon on port 13222
✓ Personal connected to daemon on port 13336
✓ Developer connected to daemon on port 14820

Fleet ready. Route requests through http://127.0.0.1:10086/command`
    },
    down: {
      desc: 'Tears down the active router, shuts down running profile daemons safely, and restores clean state.',
      cmd: 'awb down',
      out: `Stopping HTTP proxy router on port 10086...
Stopping daemon process Work (pid 58821)...
Stopping daemon process Personal (pid 58824)...
Stopping daemon process Developer (pid 58826)...

Restoring default single :10086 daemon binding...
Fleet stopped successfully.`
    }
  };

  function showCliTab(tabKey) {
    const tabs = document.querySelectorAll('.cli-tab');
    const keys = ['mcp', 'install', 'profiles', 'connect', 'up', 'down'];
    tabs.forEach((tab, index) => {
      if (keys[index] === tabKey) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    const tabItem = cliData[tabKey];
    if (tabItem) {
      document.getElementById('cli-tab-description').textContent = tabItem.desc;
      document.getElementById('cli-command-line').textContent = tabItem.cmd;
      document.getElementById('cli-output-content').textContent = tabItem.out;
    }
  }

  // 5. Playground Live Command Builder
  let playgroundFormat = 'curl';

  function getPlaygroundPayload() {
    const profile = document.getElementById('play-profile').value;
    const action = document.getElementById('play-action').value;
    const session = document.getElementById('play-session').value;
    
    let args = {};
    if (action === 'navigate') {
      args.url = document.getElementById('play-arg-url').value;
    } else if (action === 'click') {
      args.selector = document.getElementById('play-arg-selector').value;
    } else if (action === 'extract') {
      args.format = 'text';
    } else if (action === 'tabs') {
      args.activeOnly = false;
    }

    return {
      action: action === 'extract' ? 'get_page_content' : action,
      args: args,
      session: session,
      profile: profile
    };
  }

  function updatePlaygroundAction() {
    const action = document.getElementById('play-action').value;
    const urlGroup = document.getElementById('arg-url-group');
    const selGroup = document.getElementById('arg-selector-group');

    if (action === 'navigate') {
      urlGroup.style.display = 'flex';
      selGroup.style.display = 'none';
    } else if (action === 'click') {
      urlGroup.style.display = 'none';
      selGroup.style.display = 'flex';
    } else {
      urlGroup.style.display = 'none';
      selGroup.style.display = 'none';
    }
    updatePlaygroundCode();
  }

  function setPayloadFormat(format) {
    playgroundFormat = format;
    document.getElementById('tab-curl').className = format === 'curl' ? 'payload-tab active' : 'payload-tab';
    document.getElementById('tab-json').className = format === 'json' ? 'payload-tab active' : 'payload-tab';
    updatePlaygroundCode();
  }

  function updatePlaygroundCode() {
    const payload = getPlaygroundPayload();
    const codeBox = document.getElementById('playground-code-box');
    
    if (playgroundFormat === 'json') {
      codeBox.innerHTML = syntaxHighlightJson(JSON.stringify(payload, null, 2));
    } else {
      const bodyStr = JSON.stringify(payload);
      codeBox.innerHTML = `<span class="code-accent-method">curl</span> -s -X <span class="code-accent-key">POST</span> http://127.0.0.1:10086/command \
  -H <span class="code-accent-val">'Content-Type: application/json'</span> \
  -d <span class="code-accent-val">'${bodyStr}'</span>`;
    }
  }

  function syntaxHighlightJson(json) {
    if (typeof json !== 'string') {
      json = JSON.stringify(json, undefined, 2);
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\u[a-zA-Z0-9]{4}|\[^u]|[^\"])*"(\s*:)?|(true|false|null)|[0-9]+)/g, function (match) {
      let cls = 'code-accent-val';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'code-accent-key';
        }
      } else if (/true|false/.test(match)) {
        cls = 'code-accent-method';
      } else if (/null|[0-9]/.test(match)) {
        cls = 'code-accent-num';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    });
  }

  function runPlaygroundCommand() {
    const responseBox = document.getElementById('playground-response-box');
    const statusText = document.getElementById('response-status-text');
    const statusDot = document.getElementById('response-status-dot');
    const payload = getPlaygroundPayload();

    statusText.textContent = 'Transmitting...';
    statusDot.className = 'response-status-dot loading';
    responseBox.textContent = 'POST http://127.0.0.1:10086/command HTTP/1.1\nHost: 127.0.0.1:10086\nContent-Type: application/json\n\n[Transmitting network packets to router...]';

    setTimeout(() => {
      responseBox.textContent += '\n\n[Router received payload. Routing key: "profile" = "' + payload.profile + '"]';
      responseBox.textContent += '\n[Forwarding stripped body to isolated daemon for profile: "' + payload.profile + '"...]';
      
      setTimeout(() => {
        statusText.textContent = 'Success (200 OK)';
        statusDot.className = 'response-status-dot success';
        
        let daemonResult = {};
        if (payload.action === 'navigate') {
          daemonResult = {
            success: true,
            status: 200,
            url: payload.args.url,
            title: payload.args.url.includes('mail') ? 'Gmail - Inbox' : 'Google Search Console - Overview'
          };
        } else if (payload.action === 'click') {
          daemonResult = {
            success: true,
            selector: payload.args.selector,
            clicked: true,
            timestamp: Date.now()
          };
        } else if (payload.action === 'get_page_content') {
          daemonResult = {
            success: true,
            content: `<!DOCTYPE html><html><body><h1>Control Deck</h1><p>Welcome, ${payload.profile} Account.</p></body></html>`,
            byteLength: 104
          };
        } else {
          daemonResult = {
            success: true,
            tabs: [
              { id: 1021, url: 'https://mail.google.com/', active: true },
              { id: 1022, url: 'https://github.com/', active: false }
            ]
          };
        }

        const simulatedResponse = {
          status: 'success',
          code: 200,
          profile: payload.profile,
          profileTarget: payload.profile,
          result: daemonResult
        };

        responseBox.textContent = 'HTTP/1.1 200 OK\nContent-Type: application/json; charset=utf-8\nDate: ' + new Date().toUTCString() + '\nServer: AWB-Router/1.3.1\n\n' + JSON.stringify(simulatedResponse, null, 2);
      }, 1000);

    }, 800);
  }

  updatePlaygroundCode();

  // 6. FAQ Accordion toggle logic
  function toggleFaq(btn) {
    const item = btn.parentElement;
    const content = item.querySelector('.faq-content');
    const isActive = item.classList.contains('active');

    const allItems = document.querySelectorAll('.faq-item');
    allItems.forEach(i => {
      i.classList.remove('active');
      const c = i.querySelector('.faq-content');
      if (c) c.style.maxHeight = null;
    });

    if (!isActive) {
      item.classList.add('active');
      content.style.maxHeight = content.scrollHeight + 'px';
    }
  }
