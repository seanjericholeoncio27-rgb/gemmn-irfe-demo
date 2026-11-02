import { SkeletonPage } from '@/components/Skeleton'

export default function Loading() {
  return <SkeletonPage kpis={3} rows={9} cols={6} cards={0} />
}
