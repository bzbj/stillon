interface Props {
  json: string
}

export function RawJsonMessage({ json }: Props) {
  return (
    <div className="flex gap-3 justify-start">
    
      <div className="flex-1 max-w-[90%]">
        <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted rounded-lg p-3 overflow-auto max-h-96">
          {json}
        </pre>
      </div>
    </div>
  )
}
