// App.tsx
import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import HomeScreen from './screens/HomeScreen';
import ControlScreen from './screens/ControlScreen';
import PlantsScreen from './screens/PlantsScreen';

interface TabDef {
  key: string;
  label: string;
  icon: string;
  component: React.ComponentType;
}

const TABS: TabDef[] = [
  { key: 'home', label: 'Trang chủ', icon: '🏠', component: HomeScreen },
  { key: 'control', label: 'Điều khiển', icon: '⚙️', component: ControlScreen },
  { key: 'plants', label: 'Cây trồng', icon: '🌱', component: PlantsScreen },
];

// Icon tab có animation: phóng to + nảy lên khi được chọn
function AnimatedTabIcon({ icon, focused }: { icon: string; focused: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: focused ? 1.25 : 1,
        friction: 4,
        tension: 140,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: focused ? -4 : 0,
        friction: 5,
        tension: 120,
        useNativeDriver: true,
      }),
    ]).start();
  }, [focused, scale, translateY]);

  return (
    <Animated.Text style={[styles.tabIcon, { transform: [{ scale }, { translateY }] }]}>
      {icon}
    </Animated.Text>
  );
}

// Chấm tròn nhỏ báo hiệu tab đang active, animation mờ dần + phóng to khi xuất hiện
function ActiveDot({ visible }: { visible: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(opacity, { toValue: visible ? 1 : 0, useNativeDriver: true }).start();
    Animated.spring(scale, {
      toValue: visible ? 1 : 0,
      friction: 5,
      tension: 160,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity, scale]);

  return <Animated.View style={[styles.activeDot, { opacity, transform: [{ scale }] }]} />;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('home');
  const ActiveComponent = TABS.find((t) => t.key === activeTab)!.component;

  // Animation "nảy" nhẹ khi bấm vào 1 tab (bất kể tab đó có phải tab hiện tại hay không)
  const pressScales = useRef(
    Object.fromEntries(TABS.map((t) => [t.key, new Animated.Value(1)])) as Record<string, Animated.Value>
  ).current;

  const handlePress = (key: string): void => {
    setActiveTab(key);
    const val = pressScales[key];
    val.setValue(0.85);
    Animated.spring(val, { toValue: 1, friction: 3, tension: 200, useNativeDriver: true }).start();
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.content}>
          <ActiveComponent />
        </View>
        <View style={styles.tabBar}>
          {TABS.map((tab) => {
            const focused = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={styles.tabItem}
                activeOpacity={0.7}
                onPress={() => handlePress(tab.key)}
              >
                <Animated.View style={{ transform: [{ scale: pressScales[tab.key] }] }}>
                  <AnimatedTabIcon icon={tab.icon} focused={focused} />
                </Animated.View>
                <Text style={[styles.tabLabel, focused && styles.tabLabelActive]}>{tab.label}</Text>
                <ActiveDot visible={focused} />
              </TouchableOpacity>
            );
          })}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#2e8b57' },
  content: { flex: 1 },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#eee', backgroundColor: '#fff' },
  tabItem: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  tabIcon: { fontSize: 15 },
  tabLabel: { fontSize: 13, color: '#86b399' },
  tabLabelActive: { color: '#2e8b57', fontWeight: 'bold' },
  activeDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#2e8b57',
    marginTop: 3,
  },
});