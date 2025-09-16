import { useEffect, useRef } from "react";

interface TerminalOutputProps {
  output: string[];
  className?: string;
}

export default function TerminalOutput({
  output,
  className = "",
}: TerminalOutputProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div ref={terminalRef} className={`terminal-output ${className}`}>
      {output.map((line, index) => (
        <div key={index} className="mb-1">
          {line}
        </div>
      ))}
      {output.length === 0 && (
        <div className="text-gray-500">Terminal output will appear here...</div>
      )}
    </div>
  );
}
