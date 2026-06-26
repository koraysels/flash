import * as RadixTabs from '@radix-ui/react-tabs'
import type { ReactNode } from 'react'

// Swiss-styled tab system: sharp borders, monospace uppercase labels, black/white
// invert on the active tab. Keyboard + ARIA come from Radix.

export function Tabs({
  tabs,
  defaultValue,
  children,
}: {
  tabs: Array<{ value: string; label: string; hint?: string }>
  defaultValue?: string
  children: ReactNode
}) {
  return (
    <RadixTabs.Root defaultValue={defaultValue ?? tabs[0]?.value} className="w-full">
      <RadixTabs.List
        className="flex flex-wrap gap-px border-2 border-black bg-black mb-6"
        aria-label="Camera configuration"
      >
        {tabs.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            value={t.value}
            title={t.hint}
            className="flex-1 min-w-[8rem] bg-white px-4 py-2.5 text-xs font-bold uppercase tracking-widest
                       text-stone-500 transition-colors hover:text-black
                       data-[state=active]:bg-black data-[state=active]:text-white
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset"
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  )
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RadixTabs.Content
      value={value}
      className="focus-visible:outline-none data-[state=inactive]:hidden"
    >
      {children}
    </RadixTabs.Content>
  )
}
