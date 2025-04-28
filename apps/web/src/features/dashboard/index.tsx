import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { TopNav } from '@/components/layout/top-nav'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { RecentTasks } from './components/recent-tasks'
import { TypeORMTest } from './components/typeorm-test'
import { getNewPGliteDataSource, NewPGliteDataSource } from '@/db/newtypeorm/NewDataSource'
import { Repository } from 'typeorm'
import { SyncVisualizer } from '../sync/components/SyncVisualizer'
import { Task, User, Project, Comment } from '@repo/dataforge'

export default function Dashboard() {
  const [tableCounts, setTableCounts] = useState<{ [key: string]: number }>({});
  const [loadingStats, setLoadingStats] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [dataSource, setDataSource] = useState<NewPGliteDataSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initDataSource = async () => {
      try {
        const ds = await getNewPGliteDataSource();
        await ds.initialize();
        setDataSource(ds);
      } catch (err) {
        console.error("Error initializing DataSource in Dashboard:", err);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    if (!dataSource) {
      initDataSource();
    }
  }, [dataSource]);

  useEffect(() => {
    const fetchTableCounts = async () => {
      if (!dataSource || !dataSource.isInitialized) {
        console.log('[Dashboard] DataSource not ready yet for fetching counts.');
        return;
      }
      setLoadingStats(true);
      setError(null);
      try {
        console.log('[Dashboard] DataSource ready. Fetching table counts...');
        
        const userRepo = dataSource.getRepository(User);
        const projectRepo = dataSource.getRepository(Project);
        const taskRepo = dataSource.getRepository(Task);
        const commentRepo = dataSource.getRepository(Comment);
        
        const [userCount, projectCount, taskCount, commentCount] = await Promise.all([
          userRepo.createQueryBuilder('user').getCount(),
          projectRepo.createQueryBuilder('project').getCount(),
          taskRepo.createQueryBuilder('task').getCount(),
          commentRepo.createQueryBuilder('comment').getCount()
        ]);
        
        console.log('[Dashboard] Counts received:', { userCount, projectCount, taskCount, commentCount });

        const counts = {
          users: userCount,
          projects: projectCount,
          tasks: taskCount,
          comments: commentCount,
        };
        setTableCounts(counts);
      } catch (err) {
        console.error("Error fetching table counts:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingStats(false);
      }
    };

    fetchTableCounts();
  }, [dataSource]);

  return (
    <>
      {/* ===== Top Heading ===== */}
      <Header>
        <TopNav links={topNav} />
        <div className='ml-auto flex items-center space-x-4'>
          <Search />
          <ThemeSwitch />
          <ProfileDropdown />
        </div>
      </Header>

      {/* ===== Main ===== */}
      <Main>
        <div className='mb-2 flex items-center justify-between space-y-2'>
          <h1 className='text-2xl font-bold tracking-tight'>Dashboard</h1>
          <div className='flex items-center space-x-2'>
            <Button>Download</Button>
          </div>
        </div>
        {error && <div className="error-message p-4 bg-red-100 text-red-700 rounded">Error: {error}</div>}
        <Tabs
          orientation='vertical'
          value={activeTab} 
          onValueChange={setActiveTab}
          className='space-y-4'
        >
          <div className='w-full overflow-x-auto pb-2'>
            <TabsList>
              <TabsTrigger value='overview'>Overview</TabsTrigger>
              <TabsTrigger value='typeorm'>TypeORM Test</TabsTrigger>
              <TabsTrigger value='analytics' disabled>
                Analytics
              </TabsTrigger>
              <TabsTrigger value='reports' disabled>
                Reports
              </TabsTrigger>
              <TabsTrigger value='notifications' disabled>
                Notifications
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value='overview' className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>
                    Users Table
                  </CardTitle>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                    className='text-muted-foreground h-4 w-4'
                  >
                    <path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' />
                    <circle cx='9' cy='7' r='4' />
                    <path d='M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' />
                  </svg>
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>{loadingStats ? '...' : tableCounts.users ?? 0}</div>
                  <p className='text-muted-foreground text-xs'>
                    Total user records
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>
                    Projects Table
                  </CardTitle>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                    className='text-muted-foreground h-4 w-4'
                  >
                    <rect width='20' height='14' x='2' y='5' rx='2' />
                    <path d='M2 10h20' />
                  </svg>
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>{loadingStats ? '...' : tableCounts.projects ?? 0}</div>
                  <p className='text-muted-foreground text-xs'>
                    Total project records
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>Tasks Table</CardTitle>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                    className='text-muted-foreground h-4 w-4'
                  >
                    <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'></path><polyline points='14 2 14 8 20 8'></polyline><line x1='16' y1='13' x2='8' y2='13'></line><line x1='16' y1='17' x2='8' y2='17'></line><polyline points='10 9 9 9 8 9'></polyline>
                  </svg>
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>{loadingStats ? '...' : tableCounts.tasks ?? 0}</div>
                  <p className='text-muted-foreground text-xs'>
                    Total task records
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-sm font-medium'>
                    Comments Table
                  </CardTitle>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                    className='text-muted-foreground h-4 w-4'
                  >
                    <path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'></path>
                  </svg>
                </CardHeader>
                <CardContent>
                  <div className='text-2xl font-bold'>{loadingStats ? '...' : tableCounts.comments ?? 0}</div>
                  <p className='text-muted-foreground text-xs'>
                    Total comment records
                  </p>
                </CardContent>
              </Card>
            </div>
            <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
              <Card className='col-span-1 lg:col-span-1'>
                <CardHeader>
                  <CardTitle>Recent Tasks</CardTitle>
                  <CardDescription>
                    Latest updated tasks.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <RecentTasks dataSource={dataSource} />
                </CardContent>
              </Card>
              <SyncVisualizer className='col-span-1 lg:col-span-1' />
            </div>
          </TabsContent>
          
          {/* TypeORM Test Tab */}
          <TabsContent value='typeorm' className='space-y-4'>
            <div className='grid grid-cols-1 gap-4'>
              <TypeORMTest />
            </div>
          </TabsContent>
        </Tabs>
      </Main>
    </>
  )
}

const topNav = [
  {
    title: 'Overview',
    href: 'dashboard/overview',
    isActive: true,
    disabled: false,
  },
  {
    title: 'Customers',
    href: 'dashboard/customers',
    isActive: false,
    disabled: true,
  },
  {
    title: 'Products',
    href: 'dashboard/products',
    isActive: false,
    disabled: true,
  },
  {
    title: 'Settings',
    href: 'dashboard/settings',
    isActive: false,
    disabled: true,
  },
]
