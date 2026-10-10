"""Universal Agent WebBridge Client (Python 3)
Zero pip dependencies. Uses standard urllib and json. Compatible with Python 3.8+.
"""

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Union

DEFAULT_ROUTER = os.environ.get("AWB_ROUTER", "http://127.0.0.1:10086")


class WebBridgeError(Exception):
    pass


class WebBridgeClient:
    """Client for driving Google Chrome via Agent WebBridge router."""

    def __init__(
        self,
        profile: str = "Default",
        session: Optional[str] = None,
        router_url: str = DEFAULT_ROUTER,
    ):
        base = router_url.rstrip("/")
        if not base.endswith("/command"):
            self.router_url = f"{base}/command"
        else:
            self.router_url = base
        self.profile = profile
        self.session = session or f"py-session-{int(time.time())}"
        self.current_tab_id: Optional[int] = None

    def command(
        self,
        action: str,
        args: Optional[Dict[str, Any]] = None,
        timeout: int = 60,
    ) -> Any:
        payload_args = dict(args or {})

        # Automatically pin tabId to prevent focus drift across background tabs
        if (
            self.current_tab_id is not None
            and "_tabId" not in payload_args
            and action != "close_session"
        ):
            payload_args["_tabId"] = self.current_tab_id

        payload = {
            "action": action,
            "args": payload_args,
            "session": self.session,
            "profile": self.profile,
        }

        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.router_url,
            data=body,
            headers={"Content-Type": "application/json"},
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            raise WebBridgeError(
                f"Failed to reach Agent WebBridge router at {self.router_url}: {e}"
            )

        if not data.get("ok"):
            raise WebBridgeError(f"Action '{action}' failed: {data.get('error')}")

        result = data.get("data")

        # Track active tab id from navigation results
        if isinstance(result, dict) and "tabId" in result:
            self.current_tab_id = result["tabId"]

        return result

    def navigate(
        self,
        url: str,
        new_tab: bool = False,
        group_title: Optional[str] = None,
        active: Optional[bool] = None,
    ) -> Dict[str, Any]:
        args = {"url": url, "newTab": new_tab}
        if group_title:
            args["group_title"] = group_title
        if active is not None:
            args["active"] = active  # False = open in the background
        return self.command("navigate", args)

    def evaluate(self, code: str, timeout: int = 30) -> Any:
        res = self.command("evaluate", {"code": code}, timeout=timeout)
        if isinstance(res, dict) and "value" in res:
            return res["value"]
        return res

    def click(self, selector: str) -> Dict[str, Any]:
        return self.command("click", {"selector": selector})

    def trusted_click(
        self,
        selector: Optional[str] = None,
        x: Optional[float] = None,
        y: Optional[float] = None,
        button: Optional[str] = None,
        click_count: Optional[int] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {}
        if selector:
            args["selector"] = selector
        if x is not None:
            args["x"] = x
        if y is not None:
            args["y"] = y
        if button:
            args["button"] = button
        if click_count is not None:
            args["clickCount"] = click_count
        return self.command("trusted_click", args)

    def fill(self, selector: str, value: str) -> Dict[str, Any]:
        return self.command("fill", {"selector": selector, "value": value})

    def snapshot(self) -> Dict[str, Any]:
        return self.command("snapshot", {})

    def screenshot(
        self,
        path: Optional[str] = None,
        selector: Optional[str] = None,
        format: Optional[str] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {}
        if path:
            args["path"] = path
        if selector:
            args["selector"] = selector
        if format:
            args["format"] = format
        return self.command("screenshot", args)

    def upload(self, selector: str, files: Union[str, List[str]]) -> Dict[str, Any]:
        file_list = files if isinstance(files, list) else [files]
        return self.command("upload", {"selector": selector, "files": file_list})

    def file_chooser_intercept(self, enabled: bool = True) -> Dict[str, Any]:
        return self.command("file_chooser_intercept", {"enabled": enabled})

    def network(
        self,
        cmd: str,
        filter: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"cmd": cmd}
        if filter:
            args["filter"] = filter
        if request_id:
            args["requestId"] = request_id
        return self.command("network", args)

    def list_tabs(self) -> Dict[str, Any]:
        return self.command("list_tabs", {})

    def find_tab(self, url: str, active: bool = True) -> Dict[str, Any]:
        return self.command("find_tab", {"url": url, "active": active})

    def close_tab(self) -> Dict[str, Any]:
        return self.command("close_tab", {})

    def close_session(self) -> Dict[str, Any]:
        return self.command("close_session", {})

    def save_as_pdf(
        self,
        path: Optional[str] = None,
        paper_format: Optional[str] = None,
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {}
        if path:
            args["path"] = path
        if paper_format:
            args["paper_format"] = paper_format
        return self.command("save_as_pdf", args)


if __name__ == "__main__":
    import sys

    profile = sys.argv[1] if len(sys.argv) > 1 else "Default"
    client = WebBridgeClient(profile=profile, session="cli-test")
    print(f"Connecting to WebBridge for profile: {profile}...")
    try:
        res = client.navigate("https://example.com", new_tab=True, group_title="Test")
        print("Navigated successfully:", res)
        title = client.evaluate("document.title")
        print("Page title:", title)
    except Exception as err:
        print("Error:", err)
