export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:4000/api";
export const AUTH_SESSION_CHANGED_EVENT = "city-health-auth-session-changed";

export async function request(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const { authToken, ...fetchOptions } = options;
  
  // Get token from localStorage if in browser
  let token = null;
  if (authToken !== undefined) {
    token = authToken;
  } else if (typeof window !== "undefined") {
    token = localStorage.getItem("city_health_token");
  }

  const headers = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers || {})
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  console.log(`Frontend request to: ${url}`);
  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers
    });
  } catch (err) {
    // fetch rejects with a TypeError only when no HTTP response arrived. Browsers word it
    // differently ("Failed to fetch", "NetworkError when attempting...", "Load failed");
    // a refused connection and a CORS rejection are indistinguishable here. Aborts are
    // AbortError and keep their own message.
    const refused =
      err?.cause?.code === "ECONNREFUSED" ||
      err?.cause?.code === "ENOTFOUND" ||
      err?.name === "TypeError";
    if (refused) {
      // Return a friendly error object instead of throwing, so UI can render gracefully
      return { error: "Cannot reach the API. Start the backend: open a terminal in the backend folder and run npm run dev (port 4000)." };
    }
    return { error: err?.message || "Request failed" };
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const text = await response.text();
    let data = {};
    
    if (text && text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error("Failed to parse JSON response:", text);
        throw new Error(`Invalid JSON response from server: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`);
      }
    }

    if (!response.ok) {
      console.error(`API Error: ${response.status} ${response.statusText} for ${path}`, data);
      const errorMsg = data?.message || data?.error || `Request failed with status ${response.status}`;
      const invalidSession = response.status === 401 ||
        (response.status === 403 && errorMsg === "Invalid or expired token");
      // Do not let an older request sign out a newly logged-in account. A
      // permission denial for a valid account must also keep its session.
      if (token && path !== "/auth/login" && invalidSession &&
          localStorage.getItem("city_health_token") === token) {
        localStorage.removeItem("city_health_token");
        localStorage.removeItem("city_health_user");
        window.dispatchEvent(new Event(AUTH_SESSION_CHANGED_EVENT));
      }
      // Return error object instead of throwing, so UI can handle gracefully
      return { error: errorMsg };
    }

    return data;
  }

  if (!response.ok) {
    throw new Error("Request failed");
  }

  return response;
}
