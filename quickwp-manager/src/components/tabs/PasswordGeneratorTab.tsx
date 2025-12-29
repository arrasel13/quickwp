import { useState } from "react";
import {
  KeyIcon,
  ClipboardDocumentIcon,
  ArrowPathIcon,
  CheckIcon,
} from "@heroicons/react/24/outline";

export default function PasswordGeneratorTab() {
  const [password, setPassword] = useState("");
  const [length, setLength] = useState(16);
  const [includeUppercase, setIncludeUppercase] = useState(true);
  const [includeLowercase, setIncludeLowercase] = useState(true);
  const [includeNumbers, setIncludeNumbers] = useState(true);
  const [includeSymbols, setIncludeSymbols] = useState(false);
  const [copied, setCopied] = useState(false);

  const generatePassword = () => {
    let charset = "";
    if (includeUppercase) charset += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (includeLowercase) charset += "abcdefghijklmnopqrstuvwxyz";
    if (includeNumbers) charset += "0123456789";
    if (includeSymbols) charset += "!@#$%^&*()_+-=[]{}|;:,.<>?";

    if (charset === "") {
      alert("Please select at least one character type!");
      return;
    }

    let generatedPassword = "";
    for (let i = 0; i < length; i++) {
      const randomIndex = Math.floor(Math.random() * charset.length);
      generatedPassword += charset[randomIndex];
    }

    setPassword(generatedPassword);
    setCopied(false);
  };

  const copyToClipboard = async () => {
    if (password) {
      try {
        await navigator.clipboard.writeText(password);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Password Generator
          </h1>
          <p className="text-gray-600">
            Generate secure passwords for your WordPress sites
          </p>
        </div>

        {/* Password Display */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <div className="w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center mr-3">
              <KeyIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Generated Password
              </h2>
              <p className="text-gray-600 text-sm">
                Click generate to create a new password
              </p>
            </div>
          </div>

          <div className="relative">
            <input
              type="text"
              value={password}
              readOnly
              placeholder="Click 'Generate Password' to create a password"
              className="w-full px-4 py-3 pr-24 border-2 border-gray-300 rounded-lg font-mono text-md bg-gray-50 focus:outline-none focus:border-gray-300 focus:ring-0 focus:border-blue-500"
            />
            <button
              onClick={copyToClipboard}
              disabled={!password}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg font-medium transition-all ${
                copied
                  ? "bg-green-500 text-white"
                  : "bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
              }`}
            >
              {copied ? (
                <div className="flex items-center space-x-1">
                  <CheckIcon className="w-4 h-4" />
                  <span>Copied!</span>
                </div>
              ) : (
                <div className="flex items-center space-x-1">
                  <ClipboardDocumentIcon className="w-4 h-4" />
                  <span>Copy</span>
                </div>
              )}
            </button>
          </div>

          {/* Password Strength Indicator */}
          {password && (
            <>
              <div className="flex items-center space-x-3 mt-2">
                <div className="flex-1 bg-gray-200 rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all ${
                      length >= 16
                        ? "bg-green-500 w-full"
                        : length >= 12
                        ? "bg-yellow-500 w-3/4"
                        : "bg-red-500 w-1/2"
                    }`}
                  />
                </div>
                <span
                  className={`text-sm font-semibold ${
                    length >= 16
                      ? "text-green-600"
                      : length >= 12
                      ? "text-yellow-600"
                      : "text-red-600"
                  }`}
                >
                  {length >= 16 ? "Strong" : length >= 12 ? "Medium" : "Weak"}
                </span>
              </div>
            </>
            // <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            //   <h3 className="text-lg font-semibold text-gray-900 mb-3">
            //     Password Strength
            //   </h3>
            // </div>
          )}
        </div>

        {/* Settings */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Password Settings
          </h3>

          {/* Length Slider */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-medium text-gray-700">
                Password Length
              </label>
              <span className="text-sm font-bold text-blue-600">{length}</span>
            </div>
            <input
              type="range"
              min="8"
              max="64"
              value={length}
              onChange={(e) => setLength(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>8</span>
              <span>64</span>
            </div>
          </div>

          {/* Character Type Checkboxes */}
          <div className="space-y-3">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includeUppercase}
                onChange={(e) => setIncludeUppercase(e.target.checked)}
                className="w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">
                Include Uppercase Letters (A-Z)
              </span>
            </label>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includeLowercase}
                onChange={(e) => setIncludeLowercase(e.target.checked)}
                className="w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">
                Include Lowercase Letters (a-z)
              </span>
            </label>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includeNumbers}
                onChange={(e) => setIncludeNumbers(e.target.checked)}
                className="w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">
                Include Numbers (0-9)
              </span>
            </label>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSymbols}
                onChange={(e) => setIncludeSymbols(e.target.checked)}
                className="w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">
                Include Symbols (!@#$%^&*)
              </span>
            </label>
          </div>
        </div>

        {/* Generate Button */}
        <button
          onClick={generatePassword}
          className="w-full bg-gradient-to-r from-blue-500 to-indigo-600 text-white py-4 px-6 rounded-xl font-semibold text-lg hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg hover:shadow-xl flex items-center justify-center space-x-2"
        >
          <ArrowPathIcon className="w-6 h-6" />
          <span>Generate Password</span>
        </button>
      </div>
    </div>
  );
}
