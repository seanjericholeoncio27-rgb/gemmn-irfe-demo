import { SkeletonPage } from '@/components/Skeleton'

export default function Loading() {
  return <SkeletonPage kpis={4} rows={0} cols={0} cards={6} />
}
