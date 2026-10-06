import React, { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const [idNum, setIdNum] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { login, user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Redirect to appropriate page if already logged in
  useEffect(() => {
    setMounted(true);
    if (!authLoading && user) {
      if (user.role === "superadmin") {
        router.push("/");
      } else {
        if (user.id_num === "admin1") router.push("/admin1");
        else if (user.id_num === "admin2") router.push("/admin2");
        else if (user.id_num === "admin3") router.push("/admin3");
        else if (user.id_num === "frontdesk") router.push("/fill-up_form");
        else router.push("/");
      }
    }
  }, [user, authLoading, router]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validation
    if (!idNum.trim()) {
      setError("Please enter your username/ID number");
      return;
    }
    if (!password) {
      setError("Please enter your password");
      return;
    }
    
    setError("");
    setLoading(true);

    try {
      const result = await login(idNum.trim(), password);
      if (!result.success) {
        setError(result.message || "Invalid credentials. Please try again.");
      }
    } catch (err) {
      setError("Network error. Please check your connection and try again.");
      console.error("Login error:", err);
    } finally {
      setLoading(false);
    }
  };

  if (!mounted || authLoading) {
    return (
      <div className="layout-shell">
        <div className="site-header">
          <div className="header-left">
            <div className="header-icon">
              <i className="fas fa-shield-alt" />
            </div>
            <span>City Health Log-In Form</span>
          </div>
        </div>
        <div className="page-content flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600"></div>
            </div>
            <p className="mt-4 text-gray-600">Loading...</p>
          </div>
        </div>
        <footer className="site-footer">2025 Smart Queuing System. All rights reserved.</footer>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Login | City Health Log-In Form</title>
      </Head>
      
      <div className="layout-shell">
        {/* Header */}
        <header className="site-header">
          <div className="header-left">
            <div className="header-icon">
              <i className="fas fa-shield-alt" />
            </div>
            <span>City Health Log-In Form</span>
          </div>
          <div className="header-right">
            <div className="header-datetime" id="datetime"></div>
          </div>
        </header>

        {/* Main Content */}
        <main className="page-content flex-1 flex items-center justify-center px-4 md:px-8 py-8">
          <div className="w-full max-w-md">
            {/* Welcome Card */}
            <div className="bg-white rounded-xl shadow-lg overflow-hidden border border-gray-100 mb-6">
              {/* Card Header with gradient */}
              <div className="csu-gradient-bar px-6 md:px-8 py-8 md:py-10 text-center">
                <div className="mb-4 flex justify-center">
                  <div className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-white/20 flex items-center justify-center">
                    <i className="fas fa-lock text-white text-3xl md:text-4xl" />
                  </div>
                </div>
                <h1 className="text-white text-2xl md:text-3xl font-bold mb-2">
                  Welcome
                </h1>
                <p className="text-white/90 text-sm md:text-base">
                  Queue Management System
                </p>
              </div>

              {/* Form Section */}
              <div className="px-6 md:px-8 py-8 md:py-10">
                {/* Error Alert */}
                {error && (
                  <div className="mb-6 p-4 bg-red-50 border-l-4 border-red-500 rounded">
                    <div className="flex gap-3">
                      <div className="flex-shrink-0">
                        <i className="fas fa-exclamation-circle text-red-500 text-xl mt-0.5" />
                      </div>
                      <div>
                        <p className="text-red-800 text-sm md:text-base font-medium">{error}</p>
                      </div>
                    </div>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-5">
                  {/* ID Number Field */}
                  <div>
                    <label
                      htmlFor="id_num"
                      className="block text-sm font-semibold text-gray-700 mb-2"
                    >
                      <i className="fas fa-user-circle mr-2 text-emerald-600" />
                      Username / ID Number
                    </label>
                    <input
                      id="id_num"
                      name="id_num"
                      type="text"
                      placeholder="Enter your username or ID"
                      required
                      disabled={loading}
                      value={idNum}
                      onChange={(e) => setIdNum(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleSubmit(e)}
                      className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 transition duration-200 disabled:bg-gray-50 disabled:cursor-not-allowed"
                    />
                  </div>

                  {/* Password Field */}
                  <div>
                    <label
                      htmlFor="password"
                      className="block text-sm font-semibold text-gray-700 mb-2"
                    >
                      <i className="fas fa-lock mr-2 text-emerald-600" />
                      Password
                    </label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      placeholder="Enter your password"
                      required
                      disabled={loading}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleSubmit(e)}
                      className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 transition duration-200 disabled:bg-gray-50 disabled:cursor-not-allowed"
                    />
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-4 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white font-bold rounded-lg transition duration-200 shadow-md hover:shadow-lg flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <>
                        <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                        <span>Signing in...</span>
                      </>
                    ) : (
                      <>
                        <i className="fas fa-sign-in-alt" />
                        <span>Sign In</span>
                      </>
                    )}
                  </button>
                </form>

                {/* Helpful Info */}
                <div className="mt-6 pt-6 border-t border-gray-200">
                  <p className="text-center text-xs md:text-sm text-gray-600">
                    <i className="fas fa-info-circle mr-1 text-blue-500" />
                    For demo: Use <span className="font-semibold text-gray-800">admin1</span>/<span className="font-semibold text-gray-800">admin001</span>, <span className="font-semibold text-gray-800">admin2</span>/<span className="font-semibold text-gray-800">admin002</span>, <span className="font-semibold text-gray-800">admin3</span>/<span className="font-semibold text-gray-800">admin003</span>, <span className="font-semibold text-gray-800">frontdesk</span>/<span className="font-semibold text-gray-800">frontdesk123</span>, or <span className="font-semibold text-gray-800">superadmin</span>/<span className="font-semibold text-gray-800">superadmin123</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Footer Info */}
            <div className="text-center">
              <p className="text-xs md:text-sm text-gray-600">
                <i className="fas fa-shield-alt mr-1 text-emerald-600" />
                Secure Queue Management System
              </p>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="site-footer">
          2025 Smart Queuing System. All rights reserved.
        </footer>
      </div>

      <style jsx>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        .animate-spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </>
  );
}
