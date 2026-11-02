import { SkeletonPage } from '@/components/Skeleton'

export default function Loading() {
  return <SkeletonPage kpis={4} rows={8} cols={6} cards={0} />
}
