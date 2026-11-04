import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * Inline button control.
 *
 * DSH 0.2.1 ships `@deepseek-ai/dsh-client-ui-primitives` as a shell baseline
 * module only and its plugin guide tells plugins not to `require()` Harness
 * client packages (they change without notice and a throwing component blanks
 * the slot). The few controls this settings page needs are therefore inlined
 * here and styled with `--dsw-alias-*` theme tokens in `styles.ts`.
 */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  size?: 'sm' | 'md'
  variant?: 'default' | 'primary'
  children?: ReactNode
}

export function Button({ size = 'md', variant = 'default', children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      className="dsh-external-api-button"
      data-size={size}
      data-variant={variant}
    >{children}</button>
  )
}
