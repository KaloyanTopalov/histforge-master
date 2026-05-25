"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import logo from "@/icons/youforge_logo.png";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/videos", label: "Videos" },
  { href: "/workflows", label: "Workflows" },
  { href: "/settings", label: "Settings" },
] as const;

export function NavBar(): JSX.Element {
  const pathname = usePathname();

  return (
		<nav className="border-b border-border/60 bg-background/70 backdrop-blur-md">
			<div className="mx-auto flex max-w-5xl items-center px-4 py-3">
				<Link href="/" className="mr-8 flex items-center gap-2 font-display text-2xl font-semibold tracking-tight text-foreground">
					<Image src={logo} alt="" width={28} height={28} priority className="h-10 w-10 rounded-lg" />
					HistForge
				</Link>
				{LINKS.map(({ href, label }) => {
					const active = pathname.startsWith(href);
					return (
						<Button key={href} asChild variant="ghost" size="sm" className="mr-1">
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(active ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
							>
								{label}
							</Link>
						</Button>
					);
				})}
				<div className="ml-auto">
					<ThemeToggle />
				</div>
			</div>
		</nav>
  );
}
